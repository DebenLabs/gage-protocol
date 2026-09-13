export type Env = Record<string, string | undefined>;

function int(v: string | undefined, dflt: number): number {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`bad integer: ${v}`);
  return n;
}

function present(v: string | undefined): string | undefined {
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

export interface NotifierConfig {
  port: number;
  chainId: number;
  indexerUrl: string;
  indexerTimeoutMs: number;
  dbPath: string;
  pollIntervalMs: number;
  /** IANA time zone used in every deadline. */
  timezone: string;
  usdgDecimals: number;
  appUrl: string;
  /** A signed message older than this is rejected. */
  signatureMaxAgeSec: number;
  /** Optional, with `rpcUrl`: where the USDG address for the wallet-balance line comes from. */
  deploymentFile: string;
  rpcUrl: string | undefined;
  maxAttempts: number;
  earnMaxSnapshotAgeSec: number;
  email: { from: string | undefined; configured: boolean };
  telegram: { configured: boolean; webhookSecret: string | undefined };
  push: { publicKey: string | undefined; subject: string; configured: boolean };
  logLevel: "debug" | "info" | "warn" | "error";
}

/** Credentials live here and nowhere else; this object is never logged. */
export interface NotifierSecrets {
  resendApiKey: string | undefined;
  telegramBotToken: string | undefined;
  vapidPrivateKey: string | undefined;
}

export function loadConfig(env: Env): { config: NotifierConfig; secrets: NotifierSecrets } {
  const level = env.LOG_LEVEL ?? "info";
  if (!["debug", "info", "warn", "error"].includes(level)) throw new Error(`bad LOG_LEVEL: ${level}`);
  const secrets: NotifierSecrets = {
    resendApiKey: present(env.RESEND_API_KEY),
    telegramBotToken: present(env.TELEGRAM_BOT_TOKEN),
    vapidPrivateKey: present(env.VAPID_PRIVATE_KEY),
  };
  const from = present(env.FROM_EMAIL);
  const vapidPublic = present(env.VAPID_PUBLIC_KEY);
  const config: NotifierConfig = {
    port: int(env.PORT, 4200),
    chainId: int(env.CHAIN_ID, 46630),
    indexerUrl: env.INDEXER_URL ?? "http://localhost:42069",
    indexerTimeoutMs: int(env.INDEXER_TIMEOUT_MS, 10_000),
    dbPath: env.DB_PATH ?? "./data/notifier.db",
    pollIntervalMs: int(env.POLL_INTERVAL_MS, 60_000),
    timezone: env.NOTIFY_TIMEZONE ?? "UTC",
    usdgDecimals: int(env.USDG_DECIMALS, 6),
    appUrl: (env.APP_URL ?? "https://gage.cash").replace(/\/$/, ""),
    signatureMaxAgeSec: int(env.SIGNATURE_MAX_AGE_SEC, 600),
    deploymentFile: env.DEPLOYMENT_FILE ?? `../../contracts/deployments/${int(env.CHAIN_ID, 46630)}.json`,
    rpcUrl: present(env.RPC_URL),
    maxAttempts: int(env.MAX_SEND_ATTEMPTS, 5),
    earnMaxSnapshotAgeSec: int(env.EARN_MAX_SNAPSHOT_AGE_SEC, 300),
    email: { from, configured: secrets.resendApiKey !== undefined && from !== undefined },
    telegram: { configured: secrets.telegramBotToken !== undefined, webhookSecret: present(env.TELEGRAM_WEBHOOK_SECRET) },
    push: {
      publicKey: vapidPublic,
      subject: env.VAPID_SUBJECT ?? "mailto:hello@gage.cash",
      configured: vapidPublic !== undefined && secrets.vapidPrivateKey !== undefined,
    },
    logLevel: level as NotifierConfig["logLevel"],
  };
  return { config, secrets };
}

export function describeConfig(c: NotifierConfig): Record<string, unknown> {
  return {
    port: c.port,
    chainId: c.chainId,
    indexerUrl: c.indexerUrl,
    dbPath: c.dbPath,
    pollIntervalMs: c.pollIntervalMs,
    timezone: c.timezone,
    appUrl: c.appUrl,
    signatureMaxAgeSec: c.signatureMaxAgeSec,
    rpc: c.rpcUrl !== undefined,
    deploymentFile: c.deploymentFile,
    channels: {
      email: c.email.configured ? "resend" : "console",
      telegram: c.telegram.configured ? "telegram" : "console",
      push: c.push.configured ? "web-push" : "console",
    },
  };
}
