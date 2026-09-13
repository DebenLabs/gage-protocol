import webpush from "web-push";
import type { Channel } from "./types.js";

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** The address is the browser's PushSubscription as a JSON string (JSON.stringify emits no spaces). */
export function parsePushAddress(address: string): PushSubscriptionJson | undefined {
  try {
    const v: unknown = JSON.parse(address);
    if (typeof v !== "object" || v === null) return undefined;
    const r = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    if (typeof r.endpoint !== "string" || !r.endpoint.startsWith("https://")) return undefined;
    if (typeof r.keys?.p256dh !== "string" || typeof r.keys.auth !== "string") return undefined;
    return { endpoint: r.endpoint, keys: { p256dh: r.keys.p256dh, auth: r.keys.auth } };
  } catch {
    return undefined;
  }
}

export function validatePush(address: string): string | undefined {
  return parsePushAddress(address) === undefined ? "address must be a PushSubscription JSON string with endpoint and keys" : undefined;
}

export interface PushOptions {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function pushChannel(o: PushOptions): Channel {
  return {
    name: "push",
    dry: false,
    validateAddress: validatePush,
    send: async (address, message) => {
      const sub = parsePushAddress(address);
      if (sub === undefined) throw new Error("bad push subscription");
      await webpush.sendNotification(sub, JSON.stringify({ title: message.subject, body: message.text }), {
        vapidDetails: { subject: o.subject, publicKey: o.publicKey, privateKey: o.privateKey },
        TTL: 24 * 3_600,
      });
      return {};
    },
  };
}
