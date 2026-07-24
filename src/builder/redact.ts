// Audit redaction. Every tool call's input and result is stored for the audit trail,
// but raw OAuth codes, access/refresh tokens, service-role keys, private keys and the
// like must NEVER be persisted. This sanitizes by BOTH key name and value shape before
// anything reaches builder_tool_calls / builder_audit_events.

const SECRET_KEY_RE = /(pass(word)?|secret|token|authorization|api[_-]?key|refresh|access[_-]?token|client[_-]?secret|service[_-]?role|private[_-]?key|cookie|bearer|credential)/i;

// Value shapes that are secrets regardless of their key: Anthropic keys, Slack bot
// tokens, AWS access key ids, PEM private keys, and JWT-shaped strings.
const SECRET_VALUE_RE = /(sk-ant-[A-Za-z0-9_-]{6,}|xox[baprs]-[0-9A-Za-z-]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,})/;

export const REDACTED = "[redacted]";

/** Deep-redact a value for durable storage. Keys whose NAME looks sensitive are
 *  redacted wholesale; string values whose SHAPE looks like a credential are redacted
 *  even under an innocuous key. Structure (and non-secret data) is preserved. */
export function redact(value: unknown, keyHint?: string): unknown {
  if (keyHint !== undefined && SECRET_KEY_RE.test(keyHint)) return REDACTED;
  if (typeof value === "string") return SECRET_VALUE_RE.test(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redact(v, k);
    return out;
  }
  return value; // number | boolean | null | undefined | bigint | symbol
}

/** Convenience: a redacted, JSON-safe snapshot suitable for a jsonb audit column. */
export function redactForAudit(value: unknown): unknown {
  return redact(value);
}
