import { verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { buildMessage, type ChannelName, type Verifier } from "../src/auth.js";
import { consoleChannel } from "../src/channels/console.js";
import type { Channels } from "../src/channels/types.js";
import { validateEmail } from "../src/channels/email.js";
import { validatePush } from "../src/channels/push.js";
import { validateTelegram } from "../src/channels/telegram.js";
import { loadConfig, type NotifierConfig } from "../src/config.js";
import { createLogger, type Fields, type Logger } from "../src/log.js";
import type { IndexedDeal } from "../src/indexer.js";

/** The deal on screen 8h: #4821, 12.5 NVDA, cap 1,824.00, received 1,814.88, expires 8 Sep 2026 16:40 UTC, grace to 9 Sep 16:40. */
export const EXPIRY = Date.UTC(2026, 8, 8, 16, 40) / 1000;
export const GRACE_END = EXPIRY + 24 * 3_600;
export const FUNDED_AT = EXPIRY - 7 * 86_400;
export const NVDA = "0x5ef1332a18f501e9f7f1184e0fd653b66b9641f3";

export function designDeal(over: Partial<IndexedDeal> = {}): IndexedDeal {
  return {
    id: "4821",
    borrower: "0x014bf210f4cdaa11b1faad9f7f6bf2f42e6516a4",
    lender: "0x20a55a2c7026099c5dc20a71858c0ce5cd9d91a9",
    kind: "ERC20",
    token: NVDA,
    amountOrTokenId: (125n * 10n ** 17n).toString(),
    cap: "1824000000",
    price: "1814880000",
    fee: "9120000",
    term: 7 * 86_400,
    fundedAt: FUNDED_AT,
    expiry: EXPIRY,
    graceEnd: GRACE_END,
    state: "FUNDED",
    lane: "STOCK",
    ...over,
  };
}

export const nvdaAsset = { token: NVDA, symbol: "NVDA", decimals: 18, uiMultiplier: null };

export function testConfig(env: Record<string, string> = {}): NotifierConfig {
  return loadConfig({ DB_PATH: ":memory:", NOTIFY_TIMEZONE: "UTC", APP_URL: "https://gage.cash", ...env }).config;
}

export function testLogger(): { log: Logger; lines: Fields[] } {
  const lines: Fields[] = [];
  const log = createLogger({}, { level: "debug", write: (line) => lines.push(JSON.parse(line) as Fields) });
  return { log, lines };
}

export function consoleChannels(log: Logger): Channels {
  return {
    email: consoleChannel("email", log, validateEmail),
    telegram: consoleChannel("telegram", log, validateTelegram),
    push: consoleChannel("push", log, validatePush),
  };
}

export const eoaVerifier: Verifier = (args) => verifyMessage(args);

export interface Signed {
  account: PrivateKeyAccount;
  wallet: `0x${string}`;
  message: string;
  signature: `0x${string}`;
}

/** A throwaway wallet signing `gage notify ...` at `unix`. The key never leaves this function. */
export async function signNotify(channel: ChannelName, address: string, unix: number, account = privateKeyToAccount(generatePrivateKey())): Promise<Signed> {
  const message = buildMessage({ wallet: account.address, channel, address, unix });
  const signature = await account.signMessage({ message });
  return { account, wallet: account.address, message, signature };
}
