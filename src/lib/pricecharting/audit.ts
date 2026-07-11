/**
 * Audit logging for sensitive / write / financial operations. Every publish,
 * edit, ship, feedback, end, and refund produces an audit event. Buyer PII,
 * tokens, and other secrets are masked via sanitizeSensitiveData before storage.
 */

import type { Clock } from "./clock";
import { sanitizeSensitiveData } from "./logger";

export type AuditAction =
  | "product.lookup"
  | "product.search"
  | "valuation.compute"
  | "offer.list"
  | "offer.details"
  | "offer.publish"
  | "offer.edit"
  | "offer.ship"
  | "offer.feedback"
  | "offer.end"
  | "offer.refund"
  | "rate_limit.wait"
  | "error";

export interface AuditEvent {
  action: AuditAction;
  outcome: "success" | "failure" | "blocked";
  /** Non-sensitive summary of what happened. */
  summary: string;
  /** Extra structured context; sanitized before persistence. */
  context?: Record<string, unknown>;
}

export interface AuditRecord extends AuditEvent {
  id: string;
  timestamp: string;
}

/** Sink that persists audit records. Default keeps an in-memory ring buffer. */
export interface AuditSink {
  write(record: AuditRecord): void;
}

export class InMemoryAuditSink implements AuditSink {
  private records: AuditRecord[] = [];
  constructor(private readonly max = 1_000) {}
  write(record: AuditRecord): void {
    this.records.push(record);
    if (this.records.length > this.max) this.records.shift();
  }
  all(): readonly AuditRecord[] {
    return this.records;
  }
}

let counter = 0;

/**
 * Create and persist an audit record. Returns the stored record (with masked
 * context) so callers can attach an audit id to their response if desired.
 * `Date`/random are injected via the clock to stay deterministic in tests.
 */
export function createAuditLog(event: AuditEvent, deps: { clock: Clock; sink: AuditSink }): AuditRecord {
  counter += 1;
  const record: AuditRecord = {
    id: `pc-audit-${deps.clock.now()}-${counter}`,
    timestamp: new Date(deps.clock.now()).toISOString(),
    action: event.action,
    outcome: event.outcome,
    summary: event.summary,
    ...(event.context ? { context: sanitizeSensitiveData(event.context) } : {}),
  };
  deps.sink.write(record);
  return record;
}
