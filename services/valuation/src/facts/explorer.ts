/**
 * Blockscout API v2 client (EXPLORER_API). Holders, contract creator and verification status. Best-effort: every
 * method returns null with a reason instead of throwing, so the facts panel can show what it has.
 */
import type { Address, Hex } from "viem";
import { isAddress } from "viem";
import type { Fetcher } from "../indexer/client.js";

export interface Holder {
  address: Address;
  isContract: boolean;
  value: bigint;
}

export interface AddressInfo {
  isContract: boolean;
  isVerified: boolean;
  creatorAddress: Address | null;
  creationTx: Hex | null;
  proxyType: string | null;
  implementations: Address[];
}

export interface ExplorerResult<T> {
  value: T | null;
  reason: string | null;
}

/** Nick Johnson's deterministic CREATE2 deployer, present on Robinhood Chain (addresses.json chain.create2Factory). */
export const CREATE2_FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c" as const;

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function addr(v: unknown): Address | null {
  return typeof v === "string" && isAddress(v) ? (v.toLowerCase() as Address) : null;
}

/** What the facts assembler needs from the explorer; ExplorerClient implements it and tests substitute a fake. */
export interface Explorer {
  holders(token: Address, maxPages?: number): Promise<ExplorerResult<Holder[]>>;
  addressInfo(address: Address): Promise<ExplorerResult<AddressInfo>>;
  creatorWallet(token: Address): Promise<ExplorerResult<{ wallet: Address; via: string }>>;
}

export class ExplorerClient implements Explorer {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
    private readonly timeoutMs = 8000
  ) {}

  private async get(path: string): Promise<ExplorerResult<unknown>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(`${this.baseUrl}${path}`, { signal: ctrl.signal });
      if (!res.ok) return { value: null, reason: `explorer returned ${res.status} for ${path}` };
      return { value: await res.json(), reason: null };
    } catch (e) {
      return { value: null, reason: `explorer unreachable (${e instanceof Error ? e.message : String(e)})` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Holders sorted by balance, descending, up to `maxPages` × 50. */
  async holders(token: Address, maxPages = 3): Promise<ExplorerResult<Holder[]>> {
    const out: Holder[] = [];
    let query = "";
    for (let page = 0; page < maxPages; page++) {
      const r = await this.get(`/tokens/${token}/holders${query}`);
      const body = rec(r.value);
      if (body === null) return out.length > 0 ? { value: out, reason: r.reason } : { value: null, reason: r.reason ?? "bad holders shape" };
      const items = Array.isArray(body.items) ? body.items : [];
      for (const raw of items) {
        const item = rec(raw);
        const a = rec(item?.address);
        const hash = addr(a?.hash);
        const value = typeof item?.value === "string" && /^\d+$/.test(item.value) ? BigInt(item.value) : null;
        if (hash === null || value === null) continue;
        out.push({ address: hash, isContract: a?.is_contract === true, value });
      }
      const next = rec(body.next_page_params);
      if (next === null) break;
      query = "?" + Object.entries(next).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
    }
    out.sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0));
    return { value: out, reason: null };
  }

  async addressInfo(address: Address): Promise<ExplorerResult<AddressInfo>> {
    const r = await this.get(`/addresses/${address}`);
    const body = rec(r.value);
    if (body === null) return { value: null, reason: r.reason ?? "bad address shape" };
    const impls = Array.isArray(body.implementations) ? body.implementations.map((i) => addr(rec(i)?.address)).filter((a): a is Address => a !== null) : [];
    return {
      value: {
        isContract: body.is_contract === true,
        isVerified: body.is_verified === true,
        creatorAddress: addr(body.creator_address_hash),
        creationTx: typeof body.creation_transaction_hash === "string" ? (body.creation_transaction_hash.toLowerCase() as Hex) : null,
        proxyType: typeof body.proxy_type === "string" ? body.proxy_type : null,
        implementations: impls
      },
      reason: null
    };
  }

  async txSender(tx: Hex): Promise<ExplorerResult<Address>> {
    const r = await this.get(`/transactions/${tx}`);
    const body = rec(r.value);
    const from = addr(rec(body?.from)?.hash);
    return from === null ? { value: null, reason: r.reason ?? "bad transaction shape" } : { value: from, reason: null };
  }

  /**
   * The wallet behind a contract: the sender of its creation transaction when known (a CREATE2 factory or another
   * contract is the on-chain creator, the wallet is who paid for it), else the recorded creator.
   */
  async creatorWallet(token: Address): Promise<ExplorerResult<{ wallet: Address; via: string }>> {
    const info = await this.addressInfo(token);
    if (info.value === null) return { value: null, reason: info.reason };
    if (info.value.creationTx !== null) {
      const sender = await this.txSender(info.value.creationTx);
      if (sender.value !== null) {
        const via = info.value.creatorAddress === CREATE2_FACTORY ? "sender of the CREATE2 deployment" : "sender of the creation transaction";
        return { value: { wallet: sender.value, via }, reason: null };
      }
    }
    if (info.value.creatorAddress !== null) return { value: { wallet: info.value.creatorAddress, via: "explorer creator address" }, reason: null };
    return { value: null, reason: "explorer has no creator for this address" };
  }
}
