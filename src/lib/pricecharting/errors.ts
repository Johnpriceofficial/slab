/**
 * Centralized error normalization. Every failure surfaced to callers is a
 * `PriceChartingError` with a stable `code`. Raw stack traces, tokens, and
 * upstream auth details are never included in the normalized `message`.
 */

export type PriceChartingErrorCode =
  | "AUTHENTICATION_ERROR"
  | "SUBSCRIPTION_REQUIRED"
  | "RATE_LIMITED"
  | "INVALID_PARAMETER"
  | "MISSING_PARAMETER"
  | "PRODUCT_NOT_FOUND"
  | "AMBIGUOUS_PRODUCT"
  | "UNSUPPORTED_GRADE"
  | "INVALID_CONDITION"
  | "OFFER_NOT_FOUND"
  | "OFFER_ALREADY_ENDED"
  | "OFFER_NOT_SOLD"
  | "OFFER_ALREADY_REFUNDED"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "SERVER_ERROR"
  | "VALIDATION_ERROR"
  | "CONFIRMATION_REQUIRED"
  // Durable rate-limit reservation could not be obtained (or the reserved wait
  // exceeded the cap). We FAIL CLOSED: no PriceCharting call is made.
  | "RATE_LIMIT_RESERVATION_UNAVAILABLE"
  | "UNKNOWN_API_ERROR";

/** Codes that must never be retried — retrying cannot change the outcome. */
export const NON_RETRYABLE_CODES: ReadonlySet<PriceChartingErrorCode> = new Set([
  "AUTHENTICATION_ERROR",
  "SUBSCRIPTION_REQUIRED",
  "INVALID_PARAMETER",
  "MISSING_PARAMETER",
  "PRODUCT_NOT_FOUND",
  "AMBIGUOUS_PRODUCT",
  "UNSUPPORTED_GRADE",
  "INVALID_CONDITION",
  "OFFER_NOT_FOUND",
  "OFFER_ALREADY_ENDED",
  "OFFER_NOT_SOLD",
  "OFFER_ALREADY_REFUNDED",
  "VALIDATION_ERROR",
  "CONFIRMATION_REQUIRED",
  // Retrying an unavailable reservation in-process would just re-hit the same
  // failure and risks an unspaced upstream call — never retry, fail closed.
  "RATE_LIMIT_RESERVATION_UNAVAILABLE",
]);

export class PriceChartingError extends Error {
  readonly code: PriceChartingErrorCode;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: PriceChartingErrorCode,
    message: string,
    opts: { retryable?: boolean; httpStatus?: number; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "PriceChartingError";
    this.code = code;
    this.retryable = opts.retryable ?? !NON_RETRYABLE_CODES.has(code);
    this.httpStatus = opts.httpStatus;
    this.details = opts.details;
    if (opts.cause !== undefined) {
      // Preserve cause for internal logging without leaking it to output.
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }

  /** Normalized, safe-to-return JSON shape. Never includes stack/token/cause. */
  toJSON(): {
    status: "error";
    error_code: PriceChartingErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  } {
    return {
      status: "error",
      error_code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** Type guard. */
export function isPriceChartingError(e: unknown): e is PriceChartingError {
  return e instanceof PriceChartingError;
}

/**
 * Map an HTTP status + optional upstream error message to a normalized code.
 * PriceCharting returns `{ status: "error", "error-message": "..." }` for
 * application errors, generally with a 200; genuine transport errors carry the
 * HTTP status. Both paths funnel through here.
 */
export function normalizeHttpError(
  httpStatus: number,
  upstreamMessage?: string,
): PriceChartingError {
  const lower = (upstreamMessage ?? "").toLowerCase();

  // Offer lifecycle messages are checked first — they are specific and always
  // permanent (retrying cannot change an already-terminal offer state).
  if (lower.includes("already refunded")) {
    return new PriceChartingError("OFFER_ALREADY_REFUNDED", "This offer has already been refunded.", { httpStatus });
  }
  if (lower.includes("already ended") || lower.includes("offer ended")) {
    return new PriceChartingError("OFFER_ALREADY_ENDED", "This offer has already ended.", { httpStatus });
  }
  if (lower.includes("not sold")) {
    return new PriceChartingError("OFFER_NOT_SOLD", "This offer has not been sold.", { httpStatus });
  }
  if (lower.includes("offer") && lower.includes("not found")) {
    return new PriceChartingError("OFFER_NOT_FOUND", "The offer was not found.", { httpStatus });
  }

  if (httpStatus === 401 || lower.includes("invalid token") || lower.includes("not authorized")) {
    return new PriceChartingError("AUTHENTICATION_ERROR", "Authentication failed. Check the API token.", {
      httpStatus,
    });
  }
  if (httpStatus === 402 || lower.includes("subscription") || lower.includes("upgrade")) {
    return new PriceChartingError(
      "SUBSCRIPTION_REQUIRED",
      "This operation requires an active PriceCharting API subscription.",
      { httpStatus },
    );
  }
  if (httpStatus === 403) {
    return new PriceChartingError("AUTHENTICATION_ERROR", "Permission denied for this operation.", { httpStatus });
  }
  if (httpStatus === 404 || lower.includes("not found")) {
    return new PriceChartingError("PRODUCT_NOT_FOUND", "The requested resource was not found.", { httpStatus });
  }
  if (httpStatus === 429 || lower.includes("rate") || lower.includes("too many")) {
    return new PriceChartingError("RATE_LIMITED", "PriceCharting rate limit reached. Retry later.", {
      httpStatus,
      retryable: true,
    });
  }
  if (httpStatus === 400 || lower.includes("invalid parameter") || lower.includes("bad request")) {
    return new PriceChartingError("INVALID_PARAMETER", "One or more request parameters were invalid.", { httpStatus });
  }
  if (httpStatus === 408 || lower.includes("timeout")) {
    return new PriceChartingError("TIMEOUT", "The request to PriceCharting timed out.", { httpStatus, retryable: true });
  }
  if (httpStatus >= 500) {
    return new PriceChartingError("SERVER_ERROR", "PriceCharting returned a server error.", {
      httpStatus,
      retryable: true,
    });
  }
  return new PriceChartingError("UNKNOWN_API_ERROR", "An unexpected API error occurred.", { httpStatus });
}
