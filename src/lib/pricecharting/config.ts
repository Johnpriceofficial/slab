/**
 * PriceCharting integration — centralized configuration & constants.
 *
 * The API token is NEVER hardcoded. It is read from the environment variable
 * `PRICECHARTING_API_TOKEN`. The token is never logged, returned, or stored in
 * plaintext by any module in this package (see logger.ts / sanitizeSensitiveData).
 */

/** Public API base URL. */
export const PRICECHARTING_BASE_URL = "https://www.pricecharting.com";

/** Environment variable that holds the subscription token. */
export const TOKEN_ENV_VAR = "PRICECHARTING_API_TOKEN";

/**
 * Rate-limit budgets enforced by the centralized rate limiter (rate-limiter.ts).
 * These are hard ceilings derived from PriceCharting's published limits.
 */
export const RATE_LIMITS = {
  /** Standard API calls: max 1 request / second. */
  STANDARD_MIN_INTERVAL_MS: 1_000,
  /** CSV downloads: max 1 request / 10 minutes. */
  CSV_MIN_INTERVAL_MS: 10 * 60 * 1_000,
  /** Marketplace /api/offers, per identical URL: max 1 request / 5 minutes. */
  OFFERS_PER_URL_MIN_INTERVAL_MS: 5 * 60 * 1_000,
} as const;

/** Retry / backoff policy for transient failures. */
export const RETRY_POLICY = {
  MAX_RETRIES: 4,
  BASE_DELAY_MS: 500,
  MAX_DELAY_MS: 20_000,
  /** Full-jitter factor (0..1) applied to each computed backoff. */
  JITTER: 1,
} as const;

/** Default TTLs for the response cache (ms). */
export const CACHE_TTL = {
  PRODUCT_MS: 6 * 60 * 60 * 1_000, // product/price data refreshes slowly
  SEARCH_MS: 60 * 60 * 1_000,
  OFFERS_MS: 5 * 60 * 1_000, // aligns with the per-URL offers limit
} as const;

/** Field-length / value constraints imposed by the offer endpoints. */
export const OFFER_LIMITS = {
  DESCRIPTION_MAX: 300,
  SKU_MAX: 64,
} as const;

/**
 * Logical endpoint keys. Used to select the correct rate-limit bucket and for
 * structured logging. Not user-facing.
 */
export type EndpointKey =
  | "product"
  | "products"
  | "offers"
  | "offer-details"
  | "offer-publish"
  | "offer-feedback"
  | "offer-ship"
  | "offer-end"
  | "offer-refund"
  | "csv";

/** Map logical endpoint keys to their URL path. */
export const ENDPOINT_PATHS: Record<EndpointKey, string> = {
  product: "/api/product",
  products: "/api/products",
  offers: "/api/offers",
  "offer-details": "/api/offer-details",
  "offer-publish": "/api/offer-publish",
  "offer-feedback": "/api/offer-feedback",
  "offer-ship": "/api/offer-ship",
  "offer-end": "/api/offer-end",
  "offer-refund": "/api/offer-refund",
  csv: "/api/download-csv",
};

/**
 * Reads the API token from the environment. Throws a normalized error (caught
 * upstream) if it is missing. Kept as a function — never a module-level
 * constant — so a missing token fails loudly at call time rather than at import.
 */
export function readApiTokenFromEnv(env: Record<string, string | undefined> = getProcessEnv()): string {
  const token = env[TOKEN_ENV_VAR]?.trim();
  if (!token) {
    throw new Error(
      `Missing ${TOKEN_ENV_VAR}. Set it in the environment before calling the PriceCharting API.`,
    );
  }
  return token;
}

/** Isolated accessor so tests / non-node runtimes can inject an env object. */
export function getProcessEnv(): Record<string, string | undefined> {
  // globalThis.process may be undefined in some browser bundles; guard it.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env ?? {};
}
