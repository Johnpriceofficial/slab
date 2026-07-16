/**
 * Server-side page fetch orchestration. NEVER runs in the browser. The network
 * call is injected so it is fully unit-testable without hitting the live site
 * (CI uses a fake fetch). It is defensive by construction: HTTPS + host allowlist
 * only, response-size and timeout caps, an honest stable User-Agent, at most one
 * retry on transient 5xx/network failure, no retry on 4xx, 429/Retry-After
 * respected, manual redirect revalidation, and an in-memory circuit breaker. It
 * NEVER executes page JS, rotates proxies/UAs, or bypasses anti-bot protections;
 * a block is reported as `provider_blocked`, never evaded.
 */

import { safePriceChartingGameUrl, isAllowedRedirectTarget } from "./url";
import type { PageAdapterState } from "./types";

/** DOM-free HTTP client contract (satisfied by global fetch). */
export type PageFetch = (url: string, init: { method: "GET"; headers: Record<string, string>; redirect: "manual"; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface PageFetchDeps {
  fetch: PageFetch;
  /** Awaited before each network attempt — a durable ≤1 req/s reservation. */
  beforeRequest?: () => Promise<void>;
}

export interface PageFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
}

export interface PageFetchResult {
  state: PageAdapterState;
  html?: string;
  retry_after_seconds?: number;
}

const DEFAULTS: Required<PageFetchOptions> = {
  timeoutMs: 8000,
  maxBytes: 1_500_000, // 1.5 MB cap
  maxRedirects: 3,
  userAgent: "GradedCardValueBot/1.0 (+https://gradedcardvalue.com; contact info@gradedcardvalue.com)",
};

// In-memory circuit breaker: after repeated provider failures, fail fast for a
// cool-off window instead of hammering the provider.
const breaker = { failures: 0, openUntil: 0 };
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLOFF_MS = 5 * 60 * 1000;

function readTimeMs(): number {
  // Injected clock is unnecessary here; monotonic wall time is fine for a breaker
  // and never affects parsed values. Guarded so tests can reset via resetBreaker().
  return breaker.openUntil === 0 && breaker.failures === 0 ? 0 : Date.now();
}

/** Test/ops hook: reset the breaker. */
export function resetPageBreaker(): void {
  breaker.failures = 0;
  breaker.openUntil = 0;
}

function tripBreaker(): void {
  breaker.failures += 1;
  if (breaker.failures >= BREAKER_THRESHOLD) breaker.openUntil = Date.now() + BREAKER_COOLOFF_MS;
}

async function readCapped(res: { text(): Promise<string> }, maxBytes: number): Promise<string> {
  const body = await res.text();
  // A simple, portable size cap (chars ≈ bytes for this Latin-heavy HTML).
  return body.length > maxBytes ? body.slice(0, maxBytes) : body;
}

async function attempt(rawUrl: string, deps: PageFetchDeps, opts: Required<PageFetchOptions>): Promise<PageFetchResult> {
  let current = safePriceChartingGameUrl(rawUrl);
  if (!current) return { state: "product_mismatch" }; // caller passed a non-allowlisted URL

  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    if (deps.beforeRequest) await deps.beforeRequest();

    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;
    let res: Awaited<ReturnType<PageFetch>>;
    try {
      res = await deps.fetch(current.toString(), {
        method: "GET",
        headers: { "User-Agent": opts.userAgent, Accept: "text/html", "Accept-Encoding": "gzip, deflate, br" },
        redirect: "manual",
        signal: controller?.signal,
      });
    } catch {
      return { state: "network_error" };
    } finally {
      if (timer) clearTimeout(timer);
    }

    // Redirects: revalidate the destination against the same strict rules.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc || !isAllowedRedirectTarget(loc, current.toString())) return { state: "product_mismatch" };
      const next = safePriceChartingGameUrl(new URL(loc, current.toString()).toString());
      if (!next) return { state: "product_mismatch" };
      current = next;
      continue;
    }

    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      return { state: "rate_limited", retry_after_seconds: Number.isFinite(ra) ? ra : undefined };
    }
    if (res.status === 401 || res.status === 403) return { state: "provider_blocked" };
    if (res.status >= 400 && res.status < 500) return { state: "provider_blocked" };
    if (res.status >= 500) return { state: "network_error" }; // caller retries once
    if (res.status !== 200) return { state: "network_error" };

    const html = await readCapped(res, opts.maxBytes);
    if (!html || html.length < 200) return { state: "invalid_html" };
    return { state: "success", html };
  }
  return { state: "product_mismatch" }; // too many redirects
}

/** Fetch the page HTML with one retry on transient failure. Server-side only. */
export async function fetchProductPage(rawUrl: string, deps: PageFetchDeps, options: PageFetchOptions = {}): Promise<PageFetchResult> {
  const opts = { ...DEFAULTS, ...options };
  if (breaker.openUntil > 0 && readTimeMs() < breaker.openUntil) return { state: "provider_blocked" };

  let result = await attempt(rawUrl, deps, opts);
  // One retry ONLY for transient network/5xx. Never retry a 4xx / rate-limit.
  if (result.state === "network_error") result = await attempt(rawUrl, deps, opts);

  if (result.state === "success") resetPageBreaker();
  else if (result.state === "network_error" || result.state === "provider_blocked") tripBreaker();
  return result;
}
