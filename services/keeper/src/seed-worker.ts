import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, createWalletClient, defineChain, http, isHex, keccak256, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { compoundQuote, gasAllowed, seedConfig } from "./seed-policy.js";

const abi = parseAbi([
  "function TREASURY() view returns(address)", "function POSM() view returns(address)",
  "function tokenId() view returns(uint256)", "function releaseAt() view returns(uint40)",
  "function released() view returns(bool)",
  "function previewCompound() view returns(uint160,uint128,uint128,uint256,uint256)",
  "function compound(uint160 referenceSqrtPriceX96,uint128 minLiquidity,uint256 deadline) returns(uint128)",
]);
const nftAbi = parseAbi(["function ownerOf(uint256) view returns(address)", "function getPositionLiquidity(uint256) view returns(uint128)"]);
const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data }));
const health = { ok: true, mode: "starting", lastCheck: null as string | null, lastResult: "starting", transaction: null as Hex | null };
let stopping = false;
const stop = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { stopping = true; stop.abort(); });

async function main() {
  const config = seedConfig(process.env);
  const rawKey = process.env.KEEPER_KEY;
  if (rawKey && (!isHex(rawKey) || rawKey.length !== 66)) throw new Error("Invalid KEEPER_KEY");
  if (!config.dryRun && !rawKey) throw new Error("Live mode requires KEEPER_KEY");
  const account = rawKey ? privateKeyToAccount(rawKey as Hex) : undefined;
  delete process.env.KEEPER_KEY;
  const chain = defineChain({ id: config.chainId, name: "Robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } });
  // URL and request errors can contain RPC credentials. Only fixed outcome codes are logged below.
  const pub = createPublicClient({ chain, transport: http(config.rpcUrl, { timeout: 20_000, retryCount: 2 }) });
  const wallet = account ? createWalletClient({ account, chain, transport: http(config.rpcUrl, { timeout: 20_000, retryCount: 0 }) }) : undefined;
  const c = { address: config.locker, abi } as const;
  const server = createServer((req, res) => {
    if (req.url !== "/health") { res.writeHead(404).end(); return; }
    res.writeHead(health.ok ? 200 : 503, { "Content-Type": "application/json" }).end(JSON.stringify(health));
  });
  if (process.env.PORT) server.listen(Number(process.env.PORT), "0.0.0.0");
  health.mode = config.dryRun ? "simulation" : "live";
  log("seed-worker-start", { chainId: config.chainId, locker: config.locker, tokenId: String(config.tokenId), mode: health.mode });

  async function cycle(): Promise<string> {
    if (await pub.getChainId() !== config.chainId) return "chain-mismatch";
    const code = await pub.getCode({ address: config.locker });
    if (!code || keccak256(code).toLowerCase() !== config.codeHash.toLowerCase()) return "code-mismatch";
    const block = await pub.getBlock();
    const at = { ...c, blockNumber: block.number };
    const [owner, posm, tokenId, releaseAt, released] = await Promise.all([
      pub.readContract({ ...at, functionName: "TREASURY" }), pub.readContract({ ...at, functionName: "POSM" }),
      pub.readContract({ ...at, functionName: "tokenId" }), pub.readContract({ ...at, functionName: "releaseAt" }),
      pub.readContract({ ...at, functionName: "released" }),
    ]);
    if (tokenId !== config.tokenId) return "nft-mismatch";
    if (released || block.timestamp >= BigInt(releaseAt)) return "lock-ended";
    if (account && account.address.toLowerCase() !== owner.toLowerCase()) return "signer-mismatch";
    if ((await pub.readContract({ address: posm, abi: nftAbi, functionName: "ownerOf", args: [tokenId] })).toLowerCase() !== config.locker.toLowerCase()) return "custody-mismatch";
    const [price, existing, additional] = await pub.readContract({ ...at, functionName: "previewCompound" });
    const quote = compoundQuote(price, existing, additional, config.minGrowthPpm);
    if (!quote) return "below-threshold";
    const request = { ...c, functionName: "compound", args: [quote.referencePrice, quote.minLiquidity, block.timestamp + 90n], account: owner } as const;
    const simulation = await pub.simulateContract(request);
    if (config.dryRun) { log("seed-simulated", { additionalLiquidity: String(simulation.result) }); return "simulated"; }
    if (!wallet || !account) return "missing-signer";
    const [gasEstimate, fees, balance, latest, pending] = await Promise.all([
      pub.estimateContractGas(request), pub.estimateFeesPerGas(), pub.getBalance({ address: owner }),
      pub.getTransactionCount({ address: owner, blockTag: "latest" }), pub.getTransactionCount({ address: owner, blockTag: "pending" }),
    ]);
    if (latest !== pending) return "wallet-has-pending-transaction";
    const gas = gasEstimate * 12n / 10n;
    const maxFeePerGas = fees.maxFeePerGas;
    if (!gasAllowed(balance, gas, maxFeePerGas, config)) return "gas-limit";
    // Single sequential loop, explicit nonce, one instance. Never send a replacement on timeout.
    const hash = await wallet.writeContract({ ...request, account, gas, maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, nonce: pending });
    health.transaction = hash;
    log("seed-submitted", { hash });
    const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 120_000 });
    if (receipt.status !== "success") return "transaction-reverted";
    const afterLiquidity = await pub.readContract({ address: posm, abi: nftAbi, functionName: "getPositionLiquidity", args: [tokenId] });
    if (afterLiquidity < existing + quote.minLiquidity) return "liquidity-verification-failed";
    log("seed-compounded", { hash, addedLiquidity: String(afterLiquidity - existing) });
    return "compounded";
  }

  try {
    do {
      try {
        health.lastResult = await cycle();
        health.ok = ["below-threshold", "simulated", "compounded", "lock-ended", "wallet-has-pending-transaction"].includes(health.lastResult);
      } catch { health.ok = false; health.lastResult = "rpc-or-transaction-failed"; }
      health.lastCheck = new Date().toISOString();
      log("seed-check", { result: health.lastResult });
      if (process.argv.includes("--once")) { if (!health.ok) process.exitCode = 1; break; }
      if (!stopping) await delay(config.intervalMs, undefined, { signal: stop.signal }).catch(() => undefined);
    } while (!stopping);
  } finally { server.close(); }
}

void main().catch(() => { log("seed-startup-failed", { hint: "Check required seed configuration; no credentials are logged." }); process.exitCode = 1; });
