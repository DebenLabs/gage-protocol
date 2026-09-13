/**
 * Signs a `gage notify` message with a throwaway key (or SIGN_KEY) and prints the JSON body plus curl lines.
 *
 *   pnpm sign                                # email channel, address demo@example.com
 *   CHANNEL=telegram ADDRESS=12345 pnpm sign
 *   NOTIFIER_URL=http://localhost:4200 pnpm sign
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildMessage, isChannel } from "../src/auth.js";

async function main(): Promise<void> {
  const key = (process.env.SIGN_KEY as `0x${string}` | undefined) ?? generatePrivateKey();
  const account = privateKeyToAccount(key);
  const channel = process.env.CHANNEL ?? "email";
  if (!isChannel(channel)) throw new Error("CHANNEL must be email, telegram or push");
  const address = process.env.ADDRESS ?? "demo@example.com";
  const unix = Math.floor(Date.now() / 1000);
  const message = buildMessage({ wallet: account.address, channel, address, unix });
  const signature = await account.signMessage({ message });
  const url = process.env.NOTIFIER_URL ?? "http://localhost:4200";
  const body = { wallet: account.address, channel, address, prefs: { t48: true, t24: true, t6: true, t1: true, expiry: true, budget: true, epoch: true }, signature, message };
  const del = { signature, message };
  process.stdout.write(
    [
      `# throwaway wallet ${account.address} (key not printed)`,
      `curl -s -X POST ${url}/notify -H 'content-type: application/json' -d '${JSON.stringify(body)}'`,
      `curl -s ${url}/notify/${account.address}`,
      `curl -s -X DELETE ${url}/notify/${account.address}/${channel} -H 'content-type: application/json' -d '${JSON.stringify(del)}'`,
      "",
    ].join("\n"),
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
