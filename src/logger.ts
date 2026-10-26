import type { LogLevel } from "./config.js";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are always masked, whatever their content. */
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|bearer|code_verifier|^code$/i;
/** JWT-looking strings and bearer headers are masked even inside free text. */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function redactString(value: string, extraSecrets: readonly string[] = []): string {
  let out = value.replace(JWT_PATTERN, "[REDACTED_JWT]").replace(BEARER_PATTERN, "Bearer [REDACTED]");
  for (const s of extraSecrets) if (s.length >= 6) out = out.split(s).join("[REDACTED]");
  return out;
}

export function redact(value: unknown, extraSecrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 6) return "[…]";
  if (typeof value === "string") return redactString(value, extraSecrets);
  if (Array.isArray(value)) return value.map((v) => redact(v, extraSecrets, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactString(value.message, extraSecrets) };
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : redact(v, extraSecrets, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Structured JSON logger. Every message and metadata object goes through `redact`,
 * and the configured secret values themselves are masked as a second safety net.
 */
export function createLogger(level: LogLevel, secrets: readonly (string | undefined)[] = []): Logger {
  const known = secrets.filter((s): s is string => typeof s === "string" && s.length >= 6);
  const write = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (LEVELS[lvl] < LEVELS[level]) return;
    const line = JSON.stringify({
      level: lvl,
      time: new Date().toISOString(),
      msg: redactString(msg, known),
      ...(meta ? (redact(meta, known) as Record<string, unknown>) : {}),
    });
    if (lvl === "error") console.error(line);
    else if (lvl === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m, meta) => write("debug", m, meta),
    info: (m, meta) => write("info", m, meta),
    warn: (m, meta) => write("warn", m, meta),
    error: (m, meta) => write("error", m, meta),
  };
}
