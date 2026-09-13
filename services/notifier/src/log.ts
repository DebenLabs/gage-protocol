/**
 * Structured JSON logger: one object per line on stdout.
 * Never receives the hot-wallet key: `redact` drops any field whose name looks like a secret, as a last line of
 * defence, and the config layer never puts the key in a loggable object in the first place.
 */

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
/** Field names that end in key/secret/password/mnemonic, or in Token with a prefix (`botToken`, not `token`). */
const SECRET_KEY = /(?:^|_|[a-z])(?:key|secret|password|mnemonic)$|(?:[a-z]|_)token$/i;

export function redact(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : v;
  }
  return out;
}

/** JSON.stringify that survives bigint and Error values. */
export function serialise(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Error) return { name: v.name, message: v.message };
    return v;
  });
}

export interface LoggerOptions {
  level?: Level;
  write?: (line: string) => void;
  now?: () => Date;
}

export function createLogger(base: Fields = {}, opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? "info";
  const write = opts.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const now = opts.now ?? (() => new Date());

  const emit = (lvl: Level, msg: string, fields?: Fields): void => {
    if (LEVELS[lvl] < LEVELS[level]) return;
    write(serialise({ ts: now().toISOString(), level: lvl, msg, ...redact(base), ...(fields ? redact(fields) : {}) }));
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger({ ...base, ...fields }, { level, write, now }),
  };
}
