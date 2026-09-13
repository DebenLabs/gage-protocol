import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { consoleChannels, eoaVerifier, signNotify, testConfig, testLogger } from "./helpers.js";

const NOW = 1_800_000_000;

function makeApp() {
  const { log, lines } = testLogger();
  const db = openDb(":memory:");
  const app = createApp({
    db,
    channels: consoleChannels(log),
    config: testConfig(),
    verify: eoaVerifier,
    log,
    poller: () => ({ lastPollAt: NOW - 10, lastOkAt: NOW - 10, lastError: undefined, lastStats: undefined }),
    telegram: undefined,
    now: () => NOW,
  });
  const json = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, db, json, lines };
}

const prefs = { t48: true, t24: true, t6: true, t1: true, expiry: true, budget: false, epoch: true };

describe("HTTP surface (docs/api.md, Notifier)", () => {
  it("GET /health answers { ok, pending, sentLastHour }", async () => {
    const { json } = makeApp();
    const res = await json("GET", "/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, chainId: 46630, pending: 0, sentLastHour: 0, channels: { email: "console", telegram: "console", push: "console" } });
  });

  it("POST /notify with a valid signature subscribes; GET lists; DELETE with the scheme removes", async () => {
    const { json } = makeApp();
    const s = await signNotify("email", "borrower@example.com", NOW - 5);
    const post = await json("POST", "/notify", { wallet: s.wallet, channel: "email", address: "borrower@example.com", prefs, signature: s.signature, message: s.message });
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ ok: true });

    const get = await json("GET", `/notify/${s.wallet.toLowerCase()}`);
    expect(await get.json()).toEqual({ subscriptions: [{ channel: "email", address: "borrower@example.com", prefs, createdAt: NOW }] });

    const d = await signNotify("email", "borrower@example.com", NOW, s.account);
    const del = await json("DELETE", `/notify/${s.wallet}/email`, { signature: d.signature, message: d.message });
    expect(await del.json()).toEqual({ ok: true, deleted: true });
    expect(await (await json("GET", `/notify/${s.wallet}`)).json()).toEqual({ subscriptions: [] });
  });

  it("DELETE also accepts the signature in headers", async () => {
    const { json, app } = makeApp();
    const s = await signNotify("push", '{"endpoint":"https://push.example/x","keys":{"p256dh":"a","auth":"b"}}', NOW);
    await json("POST", "/notify", { wallet: s.wallet, channel: "push", address: s.message.split(" ")[4], prefs, signature: s.signature, message: s.message });
    const res = await app.request(`/notify/${s.wallet}/push`, { method: "DELETE", headers: { "x-gage-signature": s.signature, "x-gage-message": s.message } });
    expect(await res.json()).toEqual({ ok: true, deleted: true });
  });

  it("rejects a message older than ten minutes with 401", async () => {
    const { json } = makeApp();
    const s = await signNotify("email", "a@b.co", NOW - 601);
    const res = await json("POST", "/notify", { wallet: s.wallet, channel: "email", address: "a@b.co", prefs, signature: s.signature, message: s.message });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "stale" } });
  });

  it("rejects a signature by another wallet, a bad channel, a bad address and bad prefs", async () => {
    const { json } = makeApp();
    const s = await signNotify("email", "a@b.co", NOW);
    const other = await signNotify("email", "a@b.co", NOW);
    const forged = await json("POST", "/notify", { wallet: s.wallet, channel: "email", address: "a@b.co", prefs, signature: other.signature, message: s.message });
    expect(forged.status).toBe(401);
    expect(await forged.json()).toMatchObject({ error: { code: "signature_invalid" } });
    expect((await json("POST", "/notify", { wallet: s.wallet, channel: "sms", address: "a", prefs, signature: s.signature, message: s.message })).status).toBe(400);
    expect((await json("POST", "/notify", { wallet: s.wallet, channel: "email", address: "not-an-email", prefs, signature: s.signature, message: s.message })).status).toBe(400);
    expect((await json("POST", "/notify", { wallet: s.wallet, channel: "email", address: "a@b.co", prefs: { t48: "yes" }, signature: s.signature, message: s.message })).status).toBe(400);
    expect((await json("GET", "/notify/nope")).status).toBe(400);
  });

  it("links a Telegram chat from `/start <wallet>` on the webhook", async () => {
    const { json, db } = makeApp();
    const wallet = "0x014Bf210F4CDAA11b1Faad9F7F6Bf2F42e6516a4";
    const res = await json("POST", "/telegram/webhook", { message: { chat: { id: 987 }, text: `/start ${wallet}` } });
    expect(await res.json()).toMatchObject({ ok: true, chatId: "987" });
    expect(db.getTelegramChat(wallet)).toBe("987");
  });
});
