/**
 * HTTP surface (docs/api.md, Notifier section): POST /notify, GET /notify/:wallet, DELETE /notify/:wallet/:channel,
 * GET /health, plus POST /telegram/webhook for the bot's `/start <wallet>`.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getAddress, isAddress } from "viem";
import { authenticate, isChannel, type Verifier } from "./auth.js";
import type { Channels } from "./channels/types.js";
import type { TelegramApi } from "./channels/telegram.js";
import type { NotifierConfig } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./log.js";
import type { PollerStatus } from "./poller.js";
import { parsePrefs } from "./prefs.js";

export interface AppDeps {
  db: Db;
  channels: Channels;
  config: NotifierConfig;
  verify: Verifier;
  log: Logger;
  poller: () => PollerStatus;
  telegram: TelegramApi | undefined;
  now?: () => number;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function err(code: string, message: string, status: 400 | 401 | 404 | 500): Response {
  return Response.json({ error: { code, message } }, { status });
}

async function readJson(req: Request): Promise<Rec | undefined> {
  try {
    const v: unknown = await req.json();
    return isRec(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function createApp(deps: AppDeps): Hono {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono();
  // The web app runs on another origin (localhost:3000 in dev); allow browsers to read the JSON.
  app.use("*", cors({ origin: (o) => o ?? "*", allowHeaders: ["Content-Type", "x-gage-signature", "x-gage-message"], allowMethods: ["GET", "POST", "DELETE", "OPTIONS"] }));

  app.get("/health", (c) => {
    const status = deps.poller();
    const t = now();
    return c.json({
      ok: true,
      chainId: deps.config.chainId,
      pending: deps.db.countPending(deps.config.maxAttempts),
      sentLastHour: deps.db.countSentSince(t - 3_600),
      indexer: { ok: status.lastError === undefined && status.lastOkAt !== undefined, lastPollAt: status.lastPollAt ?? null, lastError: status.lastError ?? null },
      channels: { email: deps.channels.email.dry ? "console" : "resend", telegram: deps.channels.telegram.dry ? "console" : "telegram", push: deps.channels.push.dry ? "console" : "web-push" },
    });
  });

  app.post("/notify", async (c) => {
    const body = await readJson(c.req.raw);
    if (body === undefined) return err("bad_json", "body must be a JSON object", 400);
    const { wallet, channel, address, signature, message } = body;
    if (typeof wallet !== "string" || !isAddress(wallet)) return err("bad_wallet", "wallet must be an address", 400);
    if (!isChannel(channel)) return err("bad_channel", "channel must be email, telegram or push", 400);
    if (typeof address !== "string" || address === "" || /\s/.test(address)) return err("bad_address", "address must be a non-empty string without spaces", 400);
    if (typeof signature !== "string" || typeof message !== "string") return err("bad_signature", "signature and message are required", 400);
    const prefs = parsePrefs(body.prefs);
    if (prefs === undefined) return err("bad_prefs", "prefs must be an object of booleans", 400);
    const invalid = deps.channels[channel].validateAddress(address);
    if (invalid !== undefined) return err("bad_address", invalid, 400);

    const auth = await authenticate({ message, signature, wallet, channel, address }, now(), deps.config.signatureMaxAgeSec, deps.verify);
    if (!auth.ok) return err(auth.code, auth.detail, 401);

    deps.db.upsertSubscription({ wallet: getAddress(wallet), channel, address, prefs, createdAt: now() });
    deps.log.info("subscribed", { wallet: getAddress(wallet), channel });
    return c.json({ ok: true });
  });

  app.get("/notify/:wallet", (c) => {
    const wallet = c.req.param("wallet");
    if (!isAddress(wallet)) return err("bad_wallet", "wallet must be an address", 400);
    const subscriptions = deps.db.listSubscriptions(wallet).map((s) => ({ channel: s.channel, address: s.address, prefs: s.prefs, createdAt: s.createdAt }));
    return c.json({ subscriptions });
  });

  app.delete("/notify/:wallet/:channel", async (c) => {
    const wallet = c.req.param("wallet");
    const channel = c.req.param("channel");
    if (!isAddress(wallet)) return err("bad_wallet", "wallet must be an address", 400);
    if (!isChannel(channel)) return err("bad_channel", "channel must be email, telegram or push", 400);
    // Signature and message come in the JSON body, or in headers for clients that cannot send a DELETE body.
    const body = (await readJson(c.req.raw)) ?? {};
    const signature = typeof body.signature === "string" ? body.signature : (c.req.header("x-gage-signature") ?? "");
    const message = typeof body.message === "string" ? body.message : (c.req.header("x-gage-message") ?? "");
    if (signature === "" || message === "") return err("bad_signature", "signature and message are required (body or x-gage-* headers)", 400);

    const auth = await authenticate({ message, signature, wallet, channel }, now(), deps.config.signatureMaxAgeSec, deps.verify);
    if (!auth.ok) return err(auth.code, auth.detail, 401);

    const deleted = deps.db.deleteSubscription(wallet, channel);
    deps.log.info("unsubscribed", { wallet: getAddress(wallet), channel, deleted });
    return c.json({ ok: true, deleted });
  });

  app.post("/telegram/webhook", async (c) => {
    const secret = deps.config.telegram.webhookSecret;
    if (secret !== undefined && c.req.header("x-telegram-bot-api-secret-token") !== secret) return err("forbidden", "bad webhook secret", 401);
    const update = await readJson(c.req.raw);
    const msg = update !== undefined && isRec(update.message) ? update.message : undefined;
    const chat = msg !== undefined && isRec(msg.chat) ? msg.chat : undefined;
    const chatId = chat !== undefined && (typeof chat.id === "number" || typeof chat.id === "string") ? String(chat.id) : undefined;
    const text = msg !== undefined && typeof msg.text === "string" ? msg.text.trim() : "";
    if (chatId === undefined) return c.json({ ok: true });
    const m = /^\/start(?:@\w+)?\s+(0x[0-9a-fA-F]{40})$/.exec(text);
    let reply: string;
    if (m !== null && isAddress(m[1]!)) {
      deps.db.setTelegramChat(m[1], chatId, now());
      deps.log.info("telegram_linked", { wallet: getAddress(m[1]), chatId });
      reply = `Linked to ${getAddress(m[1])}. Your chat id is ${chatId}: use it as the address when you subscribe on gage, or leave the address as "pending" and reminders will find this chat.`;
    } else {
      reply = "Send `/start <your wallet address>` to link this chat to your gage reminders.";
    }
    if (deps.telegram !== undefined) {
      try {
        await deps.telegram.sendMessage(chatId, reply);
      } catch (e) {
        deps.log.warn("telegram_reply_failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    return c.json({ ok: true, chatId, reply });
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: `no route for ${c.req.method} ${c.req.path}` } }, 404));
  app.onError((e, c) => {
    deps.log.error("request_failed", { path: c.req.path, error: e.message });
    return c.json({ error: { code: "internal", message: "internal error" } }, 500);
  });
  return app;
}
