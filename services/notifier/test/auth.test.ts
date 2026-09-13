import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { authenticate, buildMessage, parseMessage } from "../src/auth.js";
import { eoaVerifier, signNotify } from "./helpers.js";

const NOW = 1_800_000_000;
const MAX_AGE = 600;

describe("message text", () => {
  it("builds and parses `gage notify <wallet> <channel> <address> <unix>`", () => {
    const wallet = "0x014Bf210F4CDAA11b1Faad9F7F6Bf2F42e6516a4";
    const text = buildMessage({ wallet, channel: "email", address: "a@b.co", unix: NOW });
    expect(text).toBe(`gage notify ${wallet} email a@b.co ${NOW}`);
    expect(parseMessage(text)).toEqual({ wallet, channel: "email", address: "a@b.co", unix: NOW });
    expect(parseMessage(text.toLowerCase())?.wallet).toBe(wallet);
  });
  it("rejects other shapes", () => {
    expect(parseMessage("gage notify 0x01 email a@b.co 1")).toBeUndefined();
    expect(parseMessage("gage notify 0x014Bf210F4CDAA11b1Faad9F7F6Bf2F42e6516a4 sms a@b.co 1")).toBeUndefined();
    expect(parseMessage("hello")).toBeUndefined();
  });
});

describe("authenticate", () => {
  it("accepts a fresh EIP-191 signature from the wallet", async () => {
    const s = await signNotify("email", "a@b.co", NOW - 30);
    const r = await authenticate({ message: s.message, signature: s.signature, wallet: s.wallet, channel: "email", address: "a@b.co" }, NOW, MAX_AGE, eoaVerifier);
    expect(r.ok).toBe(true);
  });
  it("accepts the wallet in any case", async () => {
    const s = await signNotify("telegram", "12345", NOW);
    const r = await authenticate({ message: s.message, signature: s.signature, wallet: s.wallet.toLowerCase(), channel: "telegram" }, NOW, MAX_AGE, eoaVerifier);
    expect(r.ok).toBe(true);
  });
  it("rejects a message older than the limit, and one from the future", async () => {
    const old = await signNotify("email", "a@b.co", NOW - MAX_AGE - 1);
    const r1 = await authenticate({ message: old.message, signature: old.signature, wallet: old.wallet, channel: "email", address: "a@b.co" }, NOW, MAX_AGE, eoaVerifier);
    expect(r1).toMatchObject({ ok: false, code: "stale" });
    const edge = await signNotify("email", "a@b.co", NOW - MAX_AGE);
    const r2 = await authenticate({ message: edge.message, signature: edge.signature, wallet: edge.wallet, channel: "email", address: "a@b.co" }, NOW, MAX_AGE, eoaVerifier);
    expect(r2.ok).toBe(true);
    const future = await signNotify("email", "a@b.co", NOW + 120);
    const r3 = await authenticate({ message: future.message, signature: future.signature, wallet: future.wallet, channel: "email", address: "a@b.co" }, NOW, MAX_AGE, eoaVerifier);
    expect(r3).toMatchObject({ ok: false, code: "stale" });
  });
  it("rejects a signature by another key", async () => {
    const s = await signNotify("email", "a@b.co", NOW);
    const other = privateKeyToAccount(generatePrivateKey());
    const forged = await other.signMessage({ message: s.message });
    const r = await authenticate({ message: s.message, signature: forged, wallet: s.wallet, channel: "email", address: "a@b.co" }, NOW, MAX_AGE, eoaVerifier);
    expect(r).toMatchObject({ ok: false, code: "signature_invalid" });
  });
  it("rejects a request that does not match the signed text", async () => {
    const s = await signNotify("email", "a@b.co", NOW);
    const base = { message: s.message, signature: s.signature, wallet: s.wallet, channel: "email", address: "a@b.co" };
    expect(await authenticate({ ...base, address: "x@y.co" }, NOW, MAX_AGE, eoaVerifier)).toMatchObject({ ok: false, code: "address_mismatch" });
    expect(await authenticate({ ...base, channel: "push" }, NOW, MAX_AGE, eoaVerifier)).toMatchObject({ ok: false, code: "channel_mismatch" });
    const other = privateKeyToAccount(generatePrivateKey());
    expect(await authenticate({ ...base, wallet: other.address }, NOW, MAX_AGE, eoaVerifier)).toMatchObject({ ok: false, code: "wallet_mismatch" });
    expect(await authenticate({ ...base, signature: "0x1234" }, NOW, MAX_AGE, eoaVerifier)).toMatchObject({ ok: false, code: "bad_signature" });
    expect(await authenticate({ ...base, message: "gage notify nope" }, NOW, MAX_AGE, eoaVerifier)).toMatchObject({ ok: false, code: "bad_message" });
  });
  it("lets DELETE authenticate without an address to compare", async () => {
    const s = await signNotify("email", "anything", NOW);
    const r = await authenticate({ message: s.message, signature: s.signature, wallet: s.wallet, channel: "email" }, NOW, MAX_AGE, eoaVerifier);
    expect(r.ok).toBe(true);
  });
});
