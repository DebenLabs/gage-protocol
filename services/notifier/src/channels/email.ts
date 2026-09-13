import type { Channel } from "./types.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(address: string): string | undefined {
  return EMAIL_RE.test(address) ? undefined : "address must be an email address";
}

export interface ResendOptions {
  apiKey: string;
  from: string;
  fetchFn?: typeof fetch;
  endpoint?: string;
}

/** Resend REST API, no SDK: one POST per message. */
export function resendChannel(o: ResendOptions): Channel {
  const fetchFn = o.fetchFn ?? fetch;
  const endpoint = o.endpoint ?? "https://api.resend.com/emails";
  return {
    name: "email",
    dry: false,
    validateAddress: validateEmail,
    send: async (address, message) => {
      const res = await fetchFn(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: o.from, to: [address], subject: message.subject, text: message.text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`resend returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { id?: string };
      return body.id === undefined ? {} : { id: body.id };
    },
  };
}
