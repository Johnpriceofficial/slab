// contracts/error-codes.ts
// Stable, user-safe error codes for the Graded Card Value V2 frontend.
// Source commit ba3953fdb68c31435c7dac732f67d8d53aa2adcb — part of the V2 backend
// contract bridge. The frontend must surface ONLY these codes; raw PostgreSQL
// errors, PostgREST bodies, provider payloads, and secrets must never reach the
// user. The BackendProvider maps backend failures onto this enum.

export const BackendErrorCode = {
  // Session / identity
  AUTH_REQUIRED: "AUTH_REQUIRED", // no valid session
  AUTH_INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS", // sign-in failed
  AUTH_CAPTCHA_REQUIRED: "AUTH_CAPTCHA_REQUIRED", // hCaptcha missing/invalid
  AUTH_ACCOUNT_SUSPENDED: "AUTH_ACCOUNT_SUSPENDED", // account suspended (create/intake refused)
  FORBIDDEN: "FORBIDDEN", // authenticated but not authorized (non-admin on admin surface, non-owner on owned row)

  // Request shape
  VALIDATION_FAILED: "VALIDATION_FAILED", // Zod/contract validation before any network call
  NOT_FOUND: "NOT_FOUND", // row/object absent or filtered by RLS (indistinguishable by design)
  CONFLICT: "CONFLICT", // duplicate certification, stale update guard, optimistic-concurrency failure
  PRECONDITION_FAILED: "PRECONDITION_FAILED", // operation gate off (e.g. hard delete disabled) or state machine refuses

  // Domain-specific stable codes (map 1:1 from backend jsonb error_code fields)
  DUPLICATE_CERTIFICATION: "DUPLICATE_CERTIFICATION",
  INVENTORY_ID_IMMUTABLE: "INVENTORY_ID_IMMUTABLE",
  HARD_DELETE_DISABLED: "HARD_DELETE_DISABLED",
  ANALYSIS_QUOTA_EXCEEDED: "ANALYSIS_QUOTA_EXCEEDED", // daily AI-analysis quota consumed
  RATE_LIMITED: "RATE_LIMITED", // shared provider rate limit (PriceCharting slot pacing)
  STALE_WRITE: "STALE_WRITE", // stale-guard rejected the mutation (pricing/reconcile)
  EBAY_NOT_CONNECTED: "EBAY_NOT_CONNECTED",
  EBAY_RECONNECT_REQUIRED: "EBAY_RECONNECT_REQUIRED", // refresh-token invalid; user must re-run OAuth
  EBAY_SYNC_BUSY: "EBAY_SYNC_BUSY", // single-flight lease held; retry later
  UPLOAD_TOO_LARGE: "UPLOAD_TOO_LARGE",
  UPLOAD_UNSUPPORTED_TYPE: "UPLOAD_UNSUPPORTED_TYPE",

  // Infrastructure
  NETWORK_ERROR: "NETWORK_ERROR", // fetch/transport failure — retriable
  BACKEND_UNAVAILABLE: "BACKEND_UNAVAILABLE", // 5xx / function cold failure — retriable with backoff
  INTERNAL_ERROR: "INTERNAL_ERROR", // anything unmapped; log correlation id, show generic message
} as const;

export type BackendErrorCode = (typeof BackendErrorCode)[keyof typeof BackendErrorCode];

/** The only error shape the V2 UI layer ever sees. */
export interface BackendError {
  code: BackendErrorCode;
  /** Safe, human-readable summary. Never a raw database/provider message. */
  message: string;
  /** Correlation id for support/audit lookup, when the backend supplied one. */
  correlationId?: string;
  /** True when an automatic or user-initiated retry is reasonable. */
  retriable: boolean;
}

/** Codes that are always safe to auto-retry with backoff. */
export const RETRIABLE_CODES: ReadonlySet<BackendErrorCode> = new Set([
  BackendErrorCode.NETWORK_ERROR,
  BackendErrorCode.BACKEND_UNAVAILABLE,
  BackendErrorCode.EBAY_SYNC_BUSY,
  BackendErrorCode.RATE_LIMITED,
]);
