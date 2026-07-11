/**
 * Structured logging + sensitive-data masking.
 *
 * The API token, buyer PII, tracking numbers, SKUs, and certification numbers
 * are NEVER emitted in clear text. `sanitizeSensitiveData` deep-clones input and
 * masks any field whose key matches a sensitive pattern, plus any token-like or
 * email-like value found anywhere in a string.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/** Keys whose values are always masked (case-insensitive substring match). */
const SENSITIVE_KEY_PATTERNS = [
  "token",
  "t", // PriceCharting's token query param is literally `t`
  "apikey",
  "api_key",
  "authorization",
  "auth",
  "password",
  "secret",
  "buyer",
  "email",
  "address",
  "street",
  "name", // buyer/shipping name — over-masking here is the safe default
  "tracking",
  "tracking-number",
  "tracking_number",
  "sku",
  "certification",
  "certification_number",
  "cert",
];

/** Exactly-named keys we DO allow through (product/console names are not PII). */
const KEY_ALLOWLIST = new Set(["product-name", "product_name", "console-name", "console_or_category", "console"]);

const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
/** A long token-ish alphanumeric run (>= 16 chars) is masked defensively. */
const TOKENISH_RE = /\b([A-Za-z0-9_-]{16,})\b/g;

/** Mask a string value showing only a short prefix/suffix. */
export function maskValue(value: string, opts: { keepStart?: number; keepEnd?: number } = {}): string {
  const keepStart = opts.keepStart ?? 0;
  const keepEnd = opts.keepEnd ?? 4;
  if (value.length <= keepStart + keepEnd) {
    return "*".repeat(Math.max(value.length, 4));
  }
  const start = value.slice(0, keepStart);
  const end = value.slice(value.length - keepEnd);
  const stars = "*".repeat(Math.max(4, value.length - keepStart - keepEnd));
  return `${start}${stars}${end}`;
}

/** Mask an email as `j***@example.com`. */
export function maskEmail(email: string): string {
  return email.replace(EMAIL_RE, (_m, first: string, domain: string) => `${first}***${domain}`);
}

/** Mask the API token as `abcd****...****wxyz`. */
export function maskToken(token: string): string {
  return maskValue(token, { keepStart: 4, keepEnd: 4 });
}

function isSensitiveKey(key: string): boolean {
  if (KEY_ALLOWLIST.has(key)) return false;
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => lower === p || lower.includes(p));
}

function maskString(s: string): string {
  return s.replace(EMAIL_RE, (_m, first: string, domain: string) => `${first}***${domain}`).replace(
    TOKENISH_RE,
    (m) => maskValue(m, { keepStart: 2, keepEnd: 2 }),
  );
}

/**
 * Deep-clone `data`, masking sensitive fields. Safe to pass any log context.
 * Never throws on cyclic structures — cycles are replaced with "[Circular]".
 */
export function sanitizeSensitiveData<T>(data: T, _seen: WeakSet<object> = new WeakSet()): T {
  if (data === null || data === undefined) return data;

  if (typeof data === "string") {
    return maskString(data) as unknown as T;
  }
  if (typeof data === "number" || typeof data === "boolean") return data;

  if (Array.isArray(data)) {
    if (_seen.has(data)) return "[Circular]" as unknown as T;
    _seen.add(data);
    return data.map((v) => sanitizeSensitiveData(v, _seen)) as unknown as T;
  }

  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (_seen.has(obj)) return "[Circular]" as unknown as T;
    _seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (isSensitiveKey(key)) {
        if (typeof value === "string" && value.length > 0) {
          out[key] = key.toLowerCase().includes("email") ? maskEmail(value) : maskValue(value);
        } else if (value === null || value === undefined) {
          out[key] = value;
        } else {
          out[key] = "***";
        }
      } else {
        out[key] = sanitizeSensitiveData(value, _seen);
      }
    }
    return out as unknown as T;
  }
  return data;
}

/** Default console logger that sanitizes every context object it receives. */
export function createConsoleLogger(minLevel: LogLevel = "info"): Logger {
  const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const emit = (level: LogLevel, message: string, context?: Record<string, unknown>) => {
    if (order[level] < order[minLevel]) return;
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(context ? { context: sanitizeSensitiveData(context) } : {}),
    };
    const line = JSON.stringify(entry);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m, c) => emit("debug", m, c),
    info: (m, c) => emit("info", m, c),
    warn: (m, c) => emit("warn", m, c),
    error: (m, c) => emit("error", m, c),
  };
}

/** No-op logger for tests that don't assert on logging. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
