import type { Channel } from "./types.js";

/** A chat id, or "pending" until the user has sent `/start <wallet>` to the bot. */
export function validateTelegram(address: string): string | undefined {
  return /^-?\d{1,20}$/.test(address) || address === "pending" ? undefined : "address must be a Telegram chat id or `pending`";
}

export interface TelegramOptions {
  botToken: string;
  fetchFn?: typeof fetch;
  apiBase?: string;
}

export interface TelegramApi {
  sendMessage(chatId: string, text: string): Promise<{ id?: string }>;
}

export function telegramApi(o: TelegramOptions): TelegramApi {
  const fetchFn = o.fetchFn ?? fetch;
  const base = o.apiBase ?? "https://api.telegram.org";
  return {
    sendMessage: async (chatId, text) => {
      const res = await fetchFn(`${base}/bot${o.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`telegram returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { result?: { message_id?: number } };
      const id = body.result?.message_id;
      return id === undefined ? {} : { id: String(id) };
    },
  };
}

export function telegramChannel(api: TelegramApi): Channel {
  return {
    name: "telegram",
    dry: false,
    validateAddress: validateTelegram,
    // The register is written for Telegram: the text is the whole message, no title line.
    send: (address, message) => api.sendMessage(address, message.text),
  };
}
