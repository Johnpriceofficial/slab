// AUTO-GENERATED — do not edit. Source: src/server/pricecharting/handler.ts
// Regenerate with: node scripts/build-pricecharting-edge-bundle.mjs


// src/lib/pricecharting/clock.ts
var systemClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random()
};

// src/lib/pricecharting/config.ts
var PRICECHARTING_BASE_URL = "https://www.pricecharting.com";
var TOKEN_ENV_VAR = "PRICECHARTING_API_TOKEN";
var RATE_LIMITS = {
  /** Standard API calls: max 1 request / second. */
  STANDARD_MIN_INTERVAL_MS: 1e3,
  /** CSV downloads: max 1 request / 10 minutes. */
  CSV_MIN_INTERVAL_MS: 10 * 60 * 1e3,
  /** Marketplace /api/offers, per identical URL: max 1 request / 5 minutes. */
  OFFERS_PER_URL_MIN_INTERVAL_MS: 5 * 60 * 1e3
};
var RETRY_POLICY = {
  MAX_RETRIES: 4,
  BASE_DELAY_MS: 500,
  MAX_DELAY_MS: 2e4,
  /** Full-jitter factor (0..1) applied to each computed backoff. */
  JITTER: 1
};
var CACHE_TTL = {
  PRODUCT_MS: 6 * 60 * 60 * 1e3,
  // product/price data refreshes slowly
  SEARCH_MS: 60 * 60 * 1e3,
  OFFERS_MS: 5 * 60 * 1e3
  // aligns with the per-URL offers limit
};
var ENDPOINT_PATHS = {
  product: "/api/product",
  products: "/api/products",
  offers: "/api/offers",
  "offer-details": "/api/offer-details",
  "offer-publish": "/api/offer-publish",
  "offer-feedback": "/api/offer-feedback",
  "offer-ship": "/api/offer-ship",
  "offer-end": "/api/offer-end",
  "offer-refund": "/api/offer-refund",
  csv: "/api/download-csv"
};
function readApiTokenFromEnv(env = getProcessEnv()) {
  const token = env[TOKEN_ENV_VAR]?.trim();
  if (!token) {
    throw new Error(
      `Missing ${TOKEN_ENV_VAR}. Set it in the environment before calling the PriceCharting API.`
    );
  }
  return token;
}
function getProcessEnv() {
  const proc = globalThis.process;
  return proc?.env ?? {};
}

// src/lib/pricecharting/rate-limiter.ts
var RateLimiter = class {
  constructor(clock) {
    this.clock = clock;
  }
  buckets = /* @__PURE__ */ new Map();
  getBucket(key, minIntervalMs) {
    let b = this.buckets.get(key);
    if (!b) {
      b = { minIntervalMs, lastStartedAt: 0, chain: Promise.resolve() };
      this.buckets.set(key, b);
    }
    return b;
  }
  /**
   * Resolve the bucket key + interval for a logical request.
   *  - CSV → its own slow bucket.
   *  - /api/offers → per-URL bucket (5 min) AND still bound by the standard 1/s.
   *  - everything else → the shared "standard" 1/s bucket.
   *
   * For offers we chain through BOTH the per-URL bucket and the standard bucket
   * so neither limit can be violated.
   */
  async acquire(opts) {
    if (opts.bucket === "csv") {
      await this.waitForBucket("csv", RATE_LIMITS.CSV_MIN_INTERVAL_MS);
      return;
    }
    if (opts.bucket === "offers") {
      const urlKey = `offers:${opts.urlKey ?? "default"}`;
      await this.waitForBucket(urlKey, RATE_LIMITS.OFFERS_PER_URL_MIN_INTERVAL_MS);
      await this.waitForBucket("standard", RATE_LIMITS.STANDARD_MIN_INTERVAL_MS);
      return;
    }
    await this.waitForBucket("standard", RATE_LIMITS.STANDARD_MIN_INTERVAL_MS);
  }
  /**
   * Serialize on the bucket's chain, then sleep until the min interval since the
   * previous grant has elapsed. Marking `lastStartedAt` BEFORE releasing the
   * chain guarantees the next waiter measures from this grant.
   */
  waitForBucket(key, minIntervalMs) {
    const bucket = this.getBucket(key, minIntervalMs);
    const run = bucket.chain.then(async () => {
      const now = this.clock.now();
      const earliest = bucket.lastStartedAt === 0 ? now : bucket.lastStartedAt + bucket.minIntervalMs;
      const waitMs = Math.max(0, earliest - now);
      if (waitMs > 0) await this.clock.sleep(waitMs);
      bucket.lastStartedAt = this.clock.now();
    });
    bucket.chain = run.catch(() => {
    });
    return run;
  }
  /** Test/inspection helper: ms until this bucket would grant, 0 if immediate. */
  msUntilAvailable(key) {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.lastStartedAt === 0) return 0;
    return Math.max(0, bucket.lastStartedAt + bucket.minIntervalMs - this.clock.now());
  }
};

// src/lib/pricecharting/cache.ts
var ResponseCache = class {
  constructor(clock) {
    this.clock = clock;
  }
  store = /* @__PURE__ */ new Map();
  inflight = /* @__PURE__ */ new Map();
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return void 0;
    if (entry.expiresAt <= this.clock.now()) {
      this.store.delete(key);
      return void 0;
    }
    return entry.value;
  }
  set(key, value, ttlMs) {
    if (ttlMs <= 0) return;
    this.store.set(key, { value, expiresAt: this.clock.now() + ttlMs });
  }
  delete(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
    this.inflight.clear();
  }
  /**
   * Read-through with duplicate suppression. If a fresh cached value exists it
   * is returned. Otherwise, if an identical request is already in flight, its
   * promise is shared. Only the first caller triggers `loader`.
   */
  async dedupe(key, ttlMs, loader) {
    const cached = this.get(key);
    if (cached !== void 0) return cached;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = (async () => {
      try {
        const value = await loader();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }
};

// src/lib/pricecharting/logger.ts
var SENSITIVE_KEY_PATTERNS = [
  "token",
  "t",
  // PriceCharting's token query param is literally `t`
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
  "name",
  // buyer/shipping name — over-masking here is the safe default
  "tracking",
  "tracking-number",
  "tracking_number",
  "sku",
  "certification",
  "certification_number",
  "cert"
];
var KEY_ALLOWLIST = /* @__PURE__ */ new Set(["product-name", "product_name", "console-name", "console_or_category", "console"]);
var EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
var TOKENISH_RE = /\b([A-Za-z0-9_-]{16,})\b/g;
function maskValue(value, opts = {}) {
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
function maskEmail(email) {
  return email.replace(EMAIL_RE, (_m, first, domain) => `${first}***${domain}`);
}
function maskToken(token) {
  return maskValue(token, { keepStart: 4, keepEnd: 4 });
}
function isSensitiveKey(key) {
  if (KEY_ALLOWLIST.has(key)) return false;
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => lower === p || lower.includes(p));
}
function maskString(s) {
  return s.replace(EMAIL_RE, (_m, first, domain) => `${first}***${domain}`).replace(
    TOKENISH_RE,
    (m) => maskValue(m, { keepStart: 2, keepEnd: 2 })
  );
}
function sanitizeSensitiveData(data, _seen = /* @__PURE__ */ new WeakSet()) {
  if (data === null || data === void 0) return data;
  if (typeof data === "string") {
    return maskString(data);
  }
  if (typeof data === "number" || typeof data === "boolean") return data;
  if (Array.isArray(data)) {
    if (_seen.has(data)) return "[Circular]";
    _seen.add(data);
    return data.map((v) => sanitizeSensitiveData(v, _seen));
  }
  if (typeof data === "object") {
    const obj = data;
    if (_seen.has(obj)) return "[Circular]";
    _seen.add(obj);
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
      if (isSensitiveKey(key)) {
        if (typeof value === "string" && value.length > 0) {
          out[key] = key.toLowerCase().includes("email") ? maskEmail(value) : maskValue(value);
        } else if (value === null || value === void 0) {
          out[key] = value;
        } else {
          out[key] = "***";
        }
      } else {
        out[key] = sanitizeSensitiveData(value, _seen);
      }
    }
    return out;
  }
  return data;
}
function createConsoleLogger(minLevel = "info") {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  const emit = (level, message, context) => {
    if (order[level] < order[minLevel]) return;
    const entry = {
      level,
      message,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      ...context ? { context: sanitizeSensitiveData(context) } : {}
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
    error: (m, c) => emit("error", m, c)
  };
}
var nullLogger = {
  debug: () => {
  },
  info: () => {
  },
  warn: () => {
  },
  error: () => {
  }
};

// src/lib/pricecharting/audit.ts
var InMemoryAuditSink = class {
  constructor(max = 1e3) {
    this.max = max;
  }
  records = [];
  write(record) {
    this.records.push(record);
    if (this.records.length > this.max) this.records.shift();
  }
  all() {
    return this.records;
  }
};

// src/lib/pricecharting/errors.ts
var NON_RETRYABLE_CODES = /* @__PURE__ */ new Set([
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
  "RATE_LIMIT_RESERVATION_UNAVAILABLE"
]);
var PriceChartingError = class extends Error {
  code;
  retryable;
  httpStatus;
  details;
  constructor(code, message, opts = {}) {
    super(message);
    this.name = "PriceChartingError";
    this.code = code;
    this.retryable = opts.retryable ?? !NON_RETRYABLE_CODES.has(code);
    this.httpStatus = opts.httpStatus;
    this.details = opts.details;
    if (opts.cause !== void 0) {
      this.cause = opts.cause;
    }
  }
  /** Normalized, safe-to-return JSON shape. Never includes stack/token/cause. */
  toJSON() {
    return {
      status: "error",
      error_code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...this.details ? { details: this.details } : {}
    };
  }
};
function isPriceChartingError(e) {
  return e instanceof PriceChartingError;
}
function normalizeHttpError(httpStatus, upstreamMessage) {
  const lower = (upstreamMessage ?? "").toLowerCase();
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
      httpStatus
    });
  }
  if (httpStatus === 402 || lower.includes("subscription") || lower.includes("upgrade")) {
    return new PriceChartingError(
      "SUBSCRIPTION_REQUIRED",
      "This operation requires an active PriceCharting API subscription.",
      { httpStatus }
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
      retryable: true
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
      retryable: true
    });
  }
  return new PriceChartingError("UNKNOWN_API_ERROR", "An unexpected API error occurred.", { httpStatus });
}

// src/lib/pricecharting/client.ts
function resolveGlobalFetch() {
  const f = globalThis.fetch;
  if (typeof f !== "function") {
    throw new PriceChartingError("NETWORK_ERROR", "No fetch implementation is available in this runtime.");
  }
  return f;
}
var PriceChartingClient = class {
  fetch;
  clock;
  logger;
  auditSink;
  rateLimiter;
  cache;
  tokenProvider;
  requestTimeoutMs;
  beforeRequest;
  constructor(deps = {}) {
    this.fetch = deps.fetch ?? resolveGlobalFetch();
    this.clock = deps.clock ?? systemClock;
    this.logger = deps.logger ?? createConsoleLogger();
    this.auditSink = deps.auditSink ?? new InMemoryAuditSink();
    this.rateLimiter = new RateLimiter(this.clock);
    this.cache = new ResponseCache(this.clock);
    this.tokenProvider = deps.tokenProvider ?? (() => readApiTokenFromEnv());
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 15e3;
    this.beforeRequest = deps.beforeRequest;
  }
  /**
   * Acquire a rate-limit slot for the given endpoint. Public so callers/tests
   * can reason about limiting explicitly; the request pipeline calls it too.
   */
  async applyRateLimit(endpoint, urlKey) {
    if (endpoint === "csv") {
      await this.rateLimiter.acquire({ bucket: "csv" });
    } else if (endpoint === "offers") {
      await this.rateLimiter.acquire({ bucket: "offers", urlKey });
    } else {
      await this.rateLimiter.acquire({ bucket: "standard" });
    }
  }
  /** Default cache TTL for an endpoint. */
  defaultTtl(endpoint) {
    if (endpoint === "product") return CACHE_TTL.PRODUCT_MS;
    if (endpoint === "products") return CACHE_TTL.SEARCH_MS;
    if (endpoint === "offers") return CACHE_TTL.OFFERS_MS;
    return 0;
  }
  /** Build the full URL with token injected. Never logged with the token intact. */
  buildUrl(endpoint, params) {
    const token = this.tokenProvider();
    const search = new URLSearchParams();
    search.set("t", token);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v === null || v === void 0) continue;
      search.set(k, String(v));
    }
    const path = ENDPOINT_PATHS[endpoint];
    const url = `${PRICECHARTING_BASE_URL}${path}?${search.toString()}`;
    const safeSearch = new URLSearchParams(search);
    safeSearch.set("t", maskToken(token));
    const safeUrl = `${PRICECHARTING_BASE_URL}${path}?${safeSearch.toString()}`;
    return { url, safeUrl };
  }
  /** Canonical, token-free cache/dedupe key. */
  cacheKey(endpoint, params) {
    const entries = Object.entries(params ?? {}).filter(([, v]) => v !== null && v !== void 0).sort(([a], [b]) => a.localeCompare(b));
    return `${endpoint}?${entries.map(([k, v]) => `${k}=${String(v)}`).join("&")}`;
  }
  /**
   * Validate a parsed API payload. PriceCharting signals application errors with
   * `{ status: "error", "error-message": "..." }`. A missing/`"success"` status
   * is treated as success. Throws a normalized PriceChartingError on failure.
   */
  validateAPIResponse(parsed, httpStatus) {
    if (parsed === null || typeof parsed !== "object") {
      throw new PriceChartingError("VALIDATION_ERROR", "API returned a non-object payload.", { httpStatus });
    }
    const obj = parsed;
    const status = typeof obj.status === "string" ? obj.status.toLowerCase() : void 0;
    if (status === "error") {
      const upstream = obj["error-message"] ?? obj["error_message"] ?? obj.message;
      throw normalizeHttpError(httpStatus === 200 ? 400 : httpStatus, upstream);
    }
    return obj;
  }
  /**
   * Execute a single HTTP attempt (no retry). Parses JSON, validates, and maps
   * transport/HTTP failures to normalized errors.
   */
  async attempt(opts) {
    const { url, safeUrl } = this.buildUrl(opts.endpoint, opts.params);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    this.logger.debug("pricecharting.request", { endpoint: opts.endpoint, url: safeUrl, method: opts.method });
    let res;
    try {
      res = await this.fetch(url, {
        method: opts.method,
        headers: opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : void 0,
        signal: controller.signal
      });
    } catch (err) {
      const aborted = err?.name === "AbortError";
      throw new PriceChartingError(
        aborted ? "TIMEOUT" : "NETWORK_ERROR",
        aborted ? "The request timed out." : "A network error occurred contacting PriceCharting.",
        { retryable: true, cause: err }
      );
    } finally {
      clearTimeout(timeout);
    }
    const bodyText = await res.text();
    if (!res.ok) {
      let upstreamMessage;
      try {
        const j = JSON.parse(bodyText);
        upstreamMessage = j["error-message"] ?? j.message;
      } catch {
      }
      throw normalizeHttpError(res.status, upstreamMessage);
    }
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch (err) {
      throw new PriceChartingError("VALIDATION_ERROR", "API returned malformed JSON.", {
        httpStatus: res.status,
        cause: err
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
  async retrySafeRequest(request) {
    let attempt = 0;
    for (; ; ) {
      try {
        return await request();
      } catch (err) {
        const pcErr = isPriceChartingError(err) ? err : new PriceChartingError("UNKNOWN_API_ERROR", "Unexpected failure.", { cause: err });
        const canRetry = pcErr.retryable && attempt < RETRY_POLICY.MAX_RETRIES;
        if (!canRetry) throw pcErr;
        const backoff = Math.min(RETRY_POLICY.MAX_DELAY_MS, RETRY_POLICY.BASE_DELAY_MS * 2 ** attempt);
        const jittered = Math.floor(backoff * RETRY_POLICY.JITTER * this.clock.random());
        this.logger.warn("pricecharting.retry", {
          code: pcErr.code,
          attempt: attempt + 1,
          backoffMs: jittered
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
  async request(opts) {
    const key = this.cacheKey(opts.endpoint, opts.params);
    const ttl = opts.cacheTtlMs ?? this.defaultTtl(opts.endpoint);
    const urlKey = opts.endpoint === "offers" ? key : void 0;
    const doNetwork = async () => {
      await this.applyRateLimit(opts.endpoint, urlKey);
      const result = await this.retrySafeRequest(async () => {
        if (this.beforeRequest) {
          try {
            await this.beforeRequest(opts.endpoint);
          } catch (e) {
            if (isPriceChartingError(e)) throw e;
            throw new PriceChartingError(
              "RATE_LIMIT_RESERVATION_UNAVAILABLE",
              "Could not reserve a rate-limit slot; refusing to call PriceCharting.",
              { retryable: false, cause: e }
            );
          }
        }
        return this.attempt(opts);
      });
      return result;
    };
    if (opts.method === "GET" && ttl > 0) {
      return this.cache.dedupe(key, ttl, doNetwork);
    }
    return doNetwork();
  }
  /** Expose the raw error code set for callers that branch on it. */
  static isCode(err, code) {
    return isPriceChartingError(err) && err.code === code;
  }
};

// src/lib/pricecharting/product.ts
var KNOWN_PRICE_FIELDS = [
  "loose-price",
  "cib-price",
  "new-price",
  "graded-price",
  "box-only-price",
  "manual-only-price",
  "bgs-10-price",
  "condition-17-price",
  "condition-18-price",
  "retail-loose-buy",
  "retail-loose-sell",
  "retail-cib-buy",
  "retail-cib-sell",
  "retail-new-buy",
  "retail-new-sell"
];
function toPennies(v) {
  if (v === null || v === void 0 || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}
function toStr(v) {
  if (v === null || v === void 0) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
function normalizeProduct(raw) {
  const raw_prices = {};
  for (const field of KNOWN_PRICE_FIELDS) {
    if (field in raw) raw_prices[field] = toPennies(raw[field]);
  }
  const id = toStr(raw.id);
  return {
    pricecharting_id: id ?? "",
    name: toStr(raw["product-name"]) ?? "",
    console_or_category: toStr(raw["console-name"]),
    release_date: toStr(raw["release-date"]),
    upc: toStr(raw.upc),
    asin: toStr(raw.asin),
    epid: toStr(raw.epid),
    genre: toStr(raw.genre),
    raw_prices
  };
}
function normalizeProductList(payload) {
  const list = payload.products ?? (Array.isArray(payload) ? payload : void 0) ?? [];
  return list.map((r) => normalizeProduct(r)).filter((p) => p.pricecharting_id !== "");
}

// src/lib/pricecharting/api.ts
async function searchProducts(client, query) {
  const q = query?.trim();
  if (!q) {
    throw new PriceChartingError("MISSING_PARAMETER", "A non-empty search query `q` is required.");
  }
  const payload = await client.request({
    endpoint: "products",
    method: "GET",
    params: { q }
  });
  return normalizeProductList(payload);
}
async function getProductById(client, productId) {
  const id = String(productId ?? "").trim();
  if (!id) {
    throw new PriceChartingError("MISSING_PARAMETER", "`id` is required for getProductById.");
  }
  const raw = await client.request({ endpoint: "product", method: "GET", params: { id } });
  const product = normalizeProduct(raw);
  if (!product.pricecharting_id) {
    throw new PriceChartingError("PRODUCT_NOT_FOUND", `No product found for id ${id}.`);
  }
  return product;
}

// src/lib/pricecharting/card-number.ts
function dropLeadingZeros(s) {
  return s.replace(/^0+(?=[0-9a-z])/i, "");
}
function canon(part) {
  if (!part) return null;
  const cleaned = part.trim().toLowerCase().replace(/[^0-9a-z]/g, "");
  if (!cleaned) return null;
  return dropLeadingZeros(cleaned);
}
function parseCardNumber(raw) {
  const display = (raw ?? "").trim();
  let numerator = null;
  let denominator = null;
  if (display) {
    const body = display.replace(/^#\s*/, "").trim();
    const slash = body.indexOf("/");
    if (slash >= 0) {
      numerator = body.slice(0, slash).trim() || null;
      denominator = body.slice(slash + 1).trim() || null;
    } else {
      numerator = body || null;
    }
  }
  const canonicalNumerator = canon(numerator);
  return {
    display,
    numerator,
    denominator,
    canonicalNumerator,
    canonicalDenominator: canon(denominator),
    isAlphanumeric: canonicalNumerator !== null && /[a-z]/.test(canonicalNumerator)
  };
}
function cardNumberToken(raw) {
  return parseCardNumber(raw).canonicalNumerator;
}

// src/lib/pricecharting/character-name.ts
var NON_CHARACTER_TOKENS = /* @__PURE__ */ new Set([
  "gx",
  "ex",
  "v",
  "vmax",
  "vstar",
  "vunion",
  "break",
  "prime",
  "legend",
  "star",
  "delta",
  "lv",
  "lvx",
  "tag",
  "team",
  "radiant",
  "shining",
  "dark",
  "light",
  "and",
  "the",
  "of",
  "de",
  "des",
  "le",
  "la",
  "el",
  "los"
]);
function nameTokens(name) {
  return (name ?? "").toLowerCase().normalize("NFKD").replace(/&/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}
function extractCharacters(name) {
  return nameTokens(name).filter(
    (t) => !NON_CHARACTER_TOKENS.has(t) && !/^\d+$/.test(t)
  );
}
function characterMatch(wantedName, candidateName) {
  const wanted = extractCharacters(wantedName);
  const candidateSet = new Set(nameTokens(candidateName));
  const missing = wanted.filter((c) => !candidateSet.has(c));
  return { ok: wanted.length > 0 && missing.length === 0, missing, wanted };
}

// src/lib/pricecharting/matching.ts
var STOPWORDS = /* @__PURE__ */ new Set(["the", "of", "a", "an", "and", "card", "edition"]);
function normalizeText(s) {
  return s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s#-]/gu, " ").replace(/\s+/g, " ").trim();
}
function tokens(s) {
  return normalizeText(s).split(" ").filter((t) => t.length > 0 && !STOPWORDS.has(t));
}
function extractHashNumber(name) {
  const m = /#\s*([0-9]+[a-z]?)/i.exec(name);
  return m ? m[1].toLowerCase() : null;
}
function numberTokenPresent(haystack, needle) {
  const n = needle.toLowerCase().replace(/[^0-9a-z]/g, "");
  if (!n) return false;
  const re = new RegExp(`(^|[^0-9a-z])#?${n}([^0-9a-z]|$)`, "i");
  return re.test(haystack);
}
function extractIdentifiers(item) {
  const ids = [];
  const push = (key, value, weight, kind = "text") => {
    if (value === null || value === void 0) return;
    const v = String(value).trim();
    if (v === "") return;
    ids.push({ key, value: v, weight, kind });
  };
  switch (item.category) {
    case "trading_card":
    case "sports_card": {
      push("card_name", item.card_name ?? item.player_or_character, 30);
      push("card_number", item.card_number, 30, "number");
      push("set", item.set, 20);
      push("subset", item.subset, 8);
