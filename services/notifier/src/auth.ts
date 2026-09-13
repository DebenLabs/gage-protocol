/**
 * EIP-191 authentication for subscription changes. The wallet signs the text
 *   `gage notify <wallet> <channel> <address> <unix>`
 * and sends it with the signature; we check the text matches the request, is fresh, and was signed by the wallet.
 */
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";

export const CHANNELS = ["email", "telegram", "push"] as const;
export type ChannelName = (typeof CHANNELS)[number];

export function isChannel(v: unknown): v is ChannelName {
  return typeof v === "string" && (CHANNELS as readonly string[]).includes(v);
}

export interface NotifyMessage {
  wallet: Address;
  channel: ChannelName;
  address: string;
  unix: number;
}

const MESSAGE_RE = /^gage notify (0x[0-9a-fA-F]{40}) (email|telegram|push) (\S+) (\d{1,12})$/;

export function buildMessage(m: NotifyMessage): string {
  return `gage notify ${m.wallet} ${m.channel} ${m.address} ${m.unix}`;
}

export function parseMessage(text: string): NotifyMessage | undefined {
  const m = MESSAGE_RE.exec(text);
  if (!m || !isAddress(m[1] ?? "") || !isChannel(m[2])) return undefined;
  return { wallet: getAddress(m[1]!), channel: m[2], address: m[3]!, unix: Number(m[4]) };
}

export type AuthFailure =
  | "bad_message"
  | "wallet_mismatch"
  | "channel_mismatch"
  | "address_mismatch"
  | "stale"
  | "bad_signature"
  | "signature_invalid";

export type AuthResult = { ok: true; message: NotifyMessage } | { ok: false; code: AuthFailure; detail: string };

export type Verifier = (args: { address: Address; message: string; signature: Hex }) => Promise<boolean>;

export interface AuthInput {
  message: string;
  signature: string;
  wallet: string;
  channel: string;
  /** When given (POST), the message's address must match it. DELETE leaves it undefined. */
  address?: string;
}

/** Pure checks on the text against the request, then the signature through `verify`. */
export async function authenticate(
  input: AuthInput,
  nowSec: number,
  maxAgeSec: number,
  verify: Verifier,
): Promise<AuthResult> {
  const parsed = parseMessage(input.message);
  if (parsed === undefined) return { ok: false, code: "bad_message", detail: "message must be `gage notify <wallet> <channel> <address> <unix>`" };
  if (!isAddress(input.wallet) || getAddress(input.wallet) !== parsed.wallet) {
    return { ok: false, code: "wallet_mismatch", detail: "message wallet differs from the request wallet" };
  }
  if (parsed.channel !== input.channel) return { ok: false, code: "channel_mismatch", detail: "message channel differs from the request channel" };
  if (input.address !== undefined && parsed.address !== input.address) {
    return { ok: false, code: "address_mismatch", detail: "message address differs from the request address" };
  }
  if (nowSec - parsed.unix > maxAgeSec) return { ok: false, code: "stale", detail: `message is older than ${maxAgeSec}s` };
  if (parsed.unix - nowSec > 60) return { ok: false, code: "stale", detail: "message timestamp is in the future" };
  if (!isHex(input.signature) || input.signature.length < 132) return { ok: false, code: "bad_signature", detail: "signature must be 0x-prefixed hex" };
  const valid = await verify({ address: parsed.wallet, message: input.message, signature: input.signature });
  if (!valid) return { ok: false, code: "signature_invalid", detail: "signature was not produced by the wallet" };
  return { ok: true, message: parsed };
}
