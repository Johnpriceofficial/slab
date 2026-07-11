/**
 * Centralized PriceCharting API client.
 *
 * Responsibilities:
 *  - Inject the token from the environment (never hardcoded, never logged).
 *  - Route EVERY request through the centralized rate limiter (applyRateLimit).
 *  - Cache + de-duplicate GET reads.
 *  - Retry ONLY transient failures with exponential backoff + full jitter.
 *  - Validate + normalize every response into typed data or a PriceChartingError.
 *
 * All time and randomness come from the injected Clock, so behavior is
 * deterministic under test.
 */

import type { Clock } from "./clock";
import { systemClock } from "./clock";
import { RateLimiter } from "./rate-limiter";
import { ResponseCache } from "./cache";
import { createConsoleLogger, maskToken, type Logger } from "./logger";
import { InMemoryAuditSink, type AuditSink } from "./audit";
import {
  PRICECHARTING_BASE_URL,
  ENDPOINT_PATHS,
  RETRY_POLICY,
  CACHE_TTL,
  readApiTokenFromEnv,
  type EndpointKey,
} from "./config";
import {
  PriceChartingError,
  normalizeHttpError,
  isPriceChartingError,
  type PriceChartingErrorCode,
} from "./errors";

/** Minimal fetch signature so any fetch implementation can be injected. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface ClientDeps {
  fetch?: FetchLike;
  clock?: Clock;
  logger?: Logger;
  auditSink?: AuditSink;
  /** Provide the token explicitly (tests); otherwise read from env at call time. */
  tokenProvider?: () => string;
  /** Per-request timeout (ms). */
  requestTimeoutMs?: number;
}

export interface RequestOptions {
  endpoint: EndpointKey;
  method: "GET" | "POST";
  /** Query/body params (token is injected automatically; never pass `t`). */
  params?: Record<string, string | number | boolean | null | undefined>;
  /** Override cache TTL; 0 disables caching for this request. */
  cacheTtlMs?: number;
  /** Idempotency key for POST writes (enables safe de-dupe of retries). */
  idempotencyKey?: string;
}

function resolveGlobalFetch(): FetchLike {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== "function") {
    throw new PriceChartingError("NETWORK_ERROR", "No fetch implementation is available in this runtime.");
  }
  return f as FetchLike;
}

export class PriceChartingClient {
  private readonly fetch: FetchLike;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly auditSink: AuditSink;
  readonly rateLimiter: RateLimiter;
  readonly cache: ResponseCache;
  private readonly tokenProvider: () => string;
  private readonly requestTimeoutMs: number;

  constructor(deps: ClientDeps = {}) {
    this.fetch = deps.fetch ?? resolveGlobalFetch();
    this.clock = deps.clock ?? systemClock;
    this.logger = deps.logger ?? createConsoleLogger();
    this.auditSink = deps.auditSink ?? new InMemoryAuditSink();
    this.rateLimiter = new RateLimiter(this.clock);
    this.cache = new ResponseCache(this.clock);
    this.tokenProvider = deps.tokenProvider ?? (() => readApiTokenFromEnv());
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 15_000;
  }

  /**
   * Acquire a rate-limit slot for the given endpoint. Public so callers/tests
   * can reason about limiting explicitly; the request pipeline calls it too.
   */
  async applyRateLimit(endpoint: EndpointKey, urlKey?: string): Promise<void> {
    if (endpoint === "csv") {
      await this.rateLimiter.acquire({ bucket: "csv" });
    } else if (endpoint === "offers") {
      await this.rateLimiter.acquire({ bucket: "offers", urlKey });
    } else {
      await this.rateLimiter.acquire({ bucket: "standard" });
    }
  }

  /** Default cache TTL for an endpoint. */
  private defaultTtl(endpoint: EndpointKey): number {
    if (endpoint === "product") return CACHE_TTL.PRODUCT_MS;
    if (endpoint === "products") return CACHE_TTL.SEARCH_MS;
    if (endpoint === "offers") return CACHE_TTL.OFFERS_MS;
    return 0; // writes and detail lookups are not cached by default
  }

  /** Build the full URL with token injected. Never logged with the token intact. */
  private buildUrl(endpoint: EndpointKey, params: RequestOptions["params"]): { url: string; safeUrl: string } {
    const token = this.tokenProvider();
    const search = new URLSearchParams();
    search.set("t", token);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v === null || v === undefined) continue;
      search.set(k, String(v));
    }
    const path = ENDPOINT_PATHS[endpoint];
    const url = `${PRICECHARTING_BASE_URL}${path}?${search.toString()}`;

    // A token-free key/URL for logging, caching, and offers per-URL limiting.
    const safeSearch = new URLSearchParams(search);
    safeSearch.set("t", maskToken(token));
    const safeUrl = `${PRICECHARTING_BASE_URL}${path}?${safeSearch.toString()}`;
    return { url, safeUrl };
  }

  /** Canonical, token-free cache/dedupe key. */
  private cacheKey(endpoint: EndpointKey, params: RequestOptions["params"]): string {
    const entries = Object.entries(params ?? {})
      .filter(([, v]) => v !== null && v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `${endpoint}?${entries.map(([k, v]) => `${k}=${String(v)}`).join("&")}`;
  }

  /**
   * Validate a parsed API payload. PriceCharting signals application errors with
   * `{ status: "error", "error-message": "..." }`. A missing/`"success"` status
   * is treated as success. Throws a normalized PriceChartingError on failure.
   */
  validateAPIResponse(parsed: unknown, httpStatus: number): Record<string, unknown> {
    if (parsed === null || typeof parsed !== "object") {
      throw new PriceChartingError("VALIDATION_ERROR", "API returned a non-object payload.", { httpStatus });
    }
    const obj = parsed as Record<string, unknown>;
    const status = typeof obj.status === "string" ? obj.status.toLowerCase() : undefined;
    if (status === "error") {
      const upstream = (obj["error-message"] ?? obj["error_message"] ?? obj.message) as string | undefined;
      throw normalizeHttpError(httpStatus === 200 ? 400 : httpStatus, upstream);
    }
    return obj;
  }

  /**
   * Execute a single HTTP attempt (no retry). Parses JSON, validates, and maps
   * transport/HTTP failures to normalized errors.
   */
  private async attempt(opts: RequestOptions): Promise<Record<string, unknown>> {
    const { url, safeUrl } = this.buildUrl(opts.endpoint, opts.params);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    this.logger.debug("pricecharting.request", { endpoint: opts.endpoint, url: safeUrl, method: opts.method });

    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetch(url, {
        method: opts.method,
        headers: opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = (err as { name?: string })?.name === "AbortError";
      throw new PriceChartingError(
        aborted ? "TIMEOUT" : "NETWORK_ERROR",
        aborted ? "The request timed out." : "A network error occurred contacting PriceCharting.",
        { retryable: true, cause: err },
      );
    } finally {
      clearTimeout(timeout);
    }

    const bodyText = await res.text();

    if (!res.ok) {
      // Try to surface an upstream error-message if the body is JSON.
      let upstreamMessage: string | undefined;
      try {
        const j = JSON.parse(bodyText) as Record<string, unknown>;
        upstreamMessage = (j["error-message"] ?? j.message) as string | undefined;
      } catch {
        /* non-JSON error body */
      }
      throw normalizeHttpError(res.status, upstreamMessage);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (err) {
      throw new PriceChartingError("VALIDATION_ERROR", "API returned malformed JSON.", {
        httpStatus: res.status,
        cause: err,
      });
    }
    return this.validateAPIResponse(parsed, res.status);
  }

  /**
   * Retry wrapper. Retries ONLY when the error is retryable (transient), using
   * exponential backoff with full jitter and a hard max-retry cap. Permanent
   * errors (auth, invalid params, not found, validation, confirmation) are
   * re-thrown immediately.
   */
  async retrySafeRequest<T>(request: () => Promise<T>): Promise<T> {
    let attempt = 0;
    // total attempts = MAX_RETRIES + 1
    for (;;) {
      try {
        return await request();
      } catch (err) {
        const pcErr = isPriceChartingError(err)
          ? err
          : new PriceChartingError("UNKNOWN_API_ERROR", "Unexpected failure.", { cause: err });

        const canRetry = pcErr.retryable && attempt < RETRY_POLICY.MAX_RETRIES;
        if (!canRetry) throw pcErr;

        const backoff = Math.min(RETRY_POLICY.MAX_DELAY_MS, RETRY_POLICY.BASE_DELAY_MS * 2 ** attempt);
        // Full jitter: sleep a random duration in [0, backoff].
        const jittered = Math.floor(backoff * RETRY_POLICY.JITTER * this.clock.random());
        this.logger.warn("pricecharting.retry", {
          code: pcErr.code,
          attempt: attempt + 1,
          backoffMs: jittered,
        });
        await this.clock.sleep(jittered);
        attempt += 1;
      }
    }
  }

  /**
   * The single entry point every endpoint wrapper uses.
   * GET: rate-limited + cached + de-duplicated + retried.
   * POST: rate-limited + retried (never cached; optional idempotency key).
   */
  async request<T = Record<string, unknown>>(opts: RequestOptions): Promise<T> {
    const key = this.cacheKey(opts.endpoint, opts.params);
    const ttl = opts.cacheTtlMs ?? this.defaultTtl(opts.endpoint);
    const urlKey = opts.endpoint === "offers" ? key : undefined;

    const doNetwork = async (): Promise<T> => {
      await this.applyRateLimit(opts.endpoint, urlKey);
      const result = await this.retrySafeRequest(() => this.attempt(opts));
      return result as T;
    };

    if (opts.method === "GET" && ttl > 0) {
      return this.cache.dedupe<T>(key, ttl, doNetwork);
    }
    return doNetwork();
  }

  /** Expose the raw error code set for callers that branch on it. */
  static isCode(err: unknown, code: PriceChartingErrorCode): boolean {
    return isPriceChartingError(err) && err.code === code;
  }
}
