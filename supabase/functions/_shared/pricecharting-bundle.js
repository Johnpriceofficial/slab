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
  "CONFIRMATION_REQUIRED"
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
  constructor(deps = {}) {
    this.fetch = deps.fetch ?? resolveGlobalFetch();
    this.clock = deps.clock ?? systemClock;
    this.logger = deps.logger ?? createConsoleLogger();
    this.auditSink = deps.auditSink ?? new InMemoryAuditSink();
    this.rateLimiter = new RateLimiter(this.clock);
    this.cache = new ResponseCache(this.clock);
    this.tokenProvider = deps.tokenProvider ?? (() => readApiTokenFromEnv());
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 15e3;
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
      const result = await this.retrySafeRequest(() => this.attempt(opts));
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
      push("year", item.year, 10, "year");
      push("manufacturer", item.manufacturer, 6);
      push("variant", item.variant ?? item.parallel ?? item.insert, 10);
      if (item.holo) push("holo", "holo", 5);
      if (item.reverse_holo) push("reverse_holo", "reverse holo", 6);
      if (item.first_edition) push("first_edition", "1st edition", 8);
      push("edition", item.edition, 5);
      push("language", item.language, 4);
      break;
    }
    case "video_game": {
      push("title", item.title, 35);
      push("console", item.console, 30, "console");
      push("region", item.region, 8);
      push("edition", item.edition ?? (item.collectors_edition ? "collector" : void 0), 10);
      push("variant", item.variant, 8);
      break;
    }
    case "comic": {
      push("series", item.series, 30);
      push("issue_number", item.issue_number, 28, "number");
      push("publisher", item.publisher, 12);
      push("year", item.publication_date, 8, "year");
      push("variant", item.variant_cover, 12);
      push("printing", item.printing, 8);
      push("edition", item.edition, 6);
      break;
    }
    case "coin": {
      push("country", item.country, 20);
      push("denomination", item.denomination, 20);
      push("year", item.year, 20, "year");
      push("mint_mark", item.mint_mark, 12);
      push("variety", item.variety, 12);
      push("composition", item.composition, 6);
      break;
    }
    default: {
      const anyItem = item;
      push("name", anyItem.name ?? anyItem.raw_description, 40);
      break;
    }
  }
  if ("raw_description" in item && item.raw_description) push("raw_description", item.raw_description, 4);
  return ids;
}
function buildSearchQuery(item) {
  const ids = extractIdentifiers(item).filter((i) => i.key !== "raw_description");
  const parts = [];
  const seen = /* @__PURE__ */ new Set();
  for (const id of ids) {
    const raw = id.kind === "number" ? `#${id.value.replace(/[^0-9a-z]/gi, "")}` : id.value;
    for (const tok of raw.split(/\s+/)) {
      const key = tok.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      parts.push(tok);
    }
  }
  const query = parts.join(" ").trim();
  if (query) return query;
  if ("raw_description" in item && item.raw_description) return item.raw_description.trim();
  return "";
}
function scoreCandidate(item, product) {
  const ids = extractIdentifiers(item);
  const hay = normalizeText(`${product.name} ${product.console_or_category ?? ""}`);
  const reasons = [];
  const conflicts = [];
  const missing = [];
  let awarded = 0;
  let possible = 0;
  let disqualified = false;
  for (const id of ids) {
    possible += id.weight;
    if (id.kind === "number") {
      const candNumber = extractHashNumber(product.name);
      const wanted = id.value.toLowerCase().replace(/[^0-9a-z]/g, "");
      if (candNumber !== null) {
        if (candNumber === wanted) {
          awarded += id.weight;
          reasons.push(`Exact ${id.key} #${wanted}`);
        } else {
          conflicts.push(`${id.key} mismatch: wanted #${wanted}, candidate #${candNumber}`);
          disqualified = true;
        }
      } else if (numberTokenPresent(hay, wanted)) {
        awarded += id.weight * 0.85;
        reasons.push(`${id.key} #${wanted} present`);
      } else {
        missing.push(`${id.key} #${wanted} not found in candidate`);
      }
      continue;
    }
    if (id.kind === "console") {
      const wantTokens2 = tokens(id.value);
      const present = wantTokens2.some((t) => hay.includes(t));
      if (present) {
        awarded += id.weight;
        reasons.push(`Console matches "${id.value}"`);
      } else {
        conflicts.push(`Console "${id.value}" not present in candidate "${product.console_or_category ?? ""}"`);
        disqualified = true;
      }
      continue;
    }
    if (id.kind === "year") {
      const yearMatch = /\b(19|20)\d{2}\b/.exec(id.value);
      const wantYear = yearMatch ? yearMatch[0] : id.value.replace(/[^0-9]/g, "").slice(0, 4);
      const relRaw = product.release_date ?? "";
      const relYear = /\b(19|20)\d{2}\b/.exec(relRaw)?.[0] ?? relRaw.slice(0, 4);
      if (wantYear && relYear) {
        if (wantYear === relYear) {
          awarded += id.weight;
          reasons.push(`Year matches ${wantYear}`);
        } else {
          conflicts.push(`Year mismatch: wanted ${wantYear}, candidate ${relYear}`);
        }
      } else {
        missing.push(`Year ${wantYear || "?"} could not be confirmed`);
      }
      continue;
    }
    const wantTokens = tokens(id.value);
    if (wantTokens.length === 0) {
      possible -= id.weight;
      continue;
    }
    const hits = wantTokens.filter((t) => hay.includes(t)).length;
    const coverage = hits / wantTokens.length;
    if (coverage > 0) {
      awarded += id.weight * coverage;
      if (coverage >= 0.99) reasons.push(`Matches ${id.key} "${id.value}"`);
      else reasons.push(`Partial ${id.key} match "${id.value}" (${Math.round(coverage * 100)}%)`);
    } else {
      missing.push(`${id.key} "${id.value}" not found`);
    }
  }
  const score = possible > 0 ? Math.round(awarded / possible * 100) : 0;
  return { product, score, awarded, possible, reasons, conflicts, missing, disqualified };
}
function requiresHighConfidence(item) {
  const anyItem = item;
  if (typeof anyItem.grade === "number") return true;
  if (anyItem.variant || anyItem.parallel || anyItem.refractor || anyItem.insert) return true;
  if (anyItem.autograph || anyItem.serial_number || anyItem.error_card) return true;
  if (anyItem.variant_cover) return true;
  return false;
}

// src/lib/pricecharting/money.ts
function convertPenniesToDollars(pennies) {
  if (pennies === null || pennies === void 0) return null;
  if (!Number.isFinite(pennies)) {
    throw new Error(`convertPenniesToDollars: expected a finite number, got ${String(pennies)}`);
  }
  if (!Number.isInteger(pennies)) {
    throw new Error(`convertPenniesToDollars: pennies must be an integer, got ${pennies}`);
  }
  return pennies / 100;
}

// src/lib/pricecharting/grade-mapping.ts
function inferPriceCategoryFromProduct(product) {
  const c = (product.console_or_category ?? "").toLowerCase();
  if (!c) return "generic";
  if (c.includes("card")) return "card";
  if (c.includes("comic")) return "comic";
  if (c.includes("coin") || c.includes("currency")) return "coin";
  const gameHints = ["nintendo", "playstation", "xbox", "sega", "gameboy", "game boy", "atari", "wii", "ps1", "ps2", "ps3", "ps4", "ps5", "switch"];
  if (gameHints.some((h) => c.includes(h))) return "video_game";
  return "generic";
}
var px = (product, field) => product.raw_prices[field] ?? null;
var dollars = (p) => convertPenniesToDollars(p);
function buildAvailableValues(product, category) {
  switch (category) {
    case "card":
      return {
        ungraded: dollars(px(product, "loose-price")),
        grade_7_to_7_5: dollars(px(product, "cib-price")),
        grade_8_to_8_5: dollars(px(product, "new-price")),
        grade_9_general: dollars(px(product, "graded-price")),
        grade_9_5_general: dollars(px(product, "box-only-price")),
        psa_10: dollars(px(product, "manual-only-price")),
        bgs_10: dollars(px(product, "bgs-10-price")),
        cgc_10: dollars(px(product, "condition-17-price")),
        sgc_10: dollars(px(product, "condition-18-price"))
      };
    case "comic":
      return {
        ungraded: dollars(px(product, "loose-price")),
        grade_4_0_to_4_5: dollars(px(product, "cib-price")),
        grade_6_0_to_6_5: dollars(px(product, "new-price")),
        grade_8_0_to_8_5: dollars(px(product, "graded-price")),
        grade_9_2: dollars(px(product, "box-only-price")),
        grade_9_4: dollars(px(product, "condition-17-price")),
        grade_9_8: dollars(px(product, "manual-only-price")),
        grade_10_0: dollars(px(product, "bgs-10-price"))
      };
    case "video_game":
      return {
        loose: dollars(px(product, "loose-price")),
        cib: dollars(px(product, "cib-price")),
        new_sealed: dollars(px(product, "new-price")),
        graded: dollars(px(product, "graded-price")),
        box_only: dollars(px(product, "box-only-price")),
        manual_only: dollars(px(product, "manual-only-price")),
        retail_loose_buy: dollars(px(product, "retail-loose-buy")),
        retail_loose_sell: dollars(px(product, "retail-loose-sell")),
        retail_cib_buy: dollars(px(product, "retail-cib-buy")),
        retail_cib_sell: dollars(px(product, "retail-cib-sell")),
        retail_new_buy: dollars(px(product, "retail-new-buy")),
        retail_new_sell: dollars(px(product, "retail-new-sell"))
      };
    case "coin":
    case "generic":
    default:
      return {
        ungraded_or_base: dollars(px(product, "loose-price")),
        secondary: dollars(px(product, "cib-price")),
        tertiary: dollars(px(product, "new-price")),
        graded_general: dollars(px(product, "graded-price")),
        high_grade_a: dollars(px(product, "box-only-price")),
        high_grade_b: dollars(px(product, "manual-only-price")),
        top_grade_bgs10_field: dollars(px(product, "bgs-10-price")),
        top_grade_c17_field: dollars(px(product, "condition-17-price")),
        top_grade_c18_field: dollars(px(product, "condition-18-price"))
      };
  }
}
var eq = (a, b) => Math.abs(a - b) < 1e-9;
var isOneOf = (g, opts) => opts.some((o) => eq(g, o));
function pickCardField(company, grade) {
  if (eq(grade, 10)) {
    switch (company) {
      case "PSA":
        return { field: "manual-only-price", meaning: "PSA 10", companySpecific: true, warnings: [] };
      case "BGS":
        return { field: "bgs-10-price", meaning: "BGS 10", companySpecific: true, warnings: [] };
      case "CGC":
        return { field: "condition-17-price", meaning: "CGC 10", companySpecific: true, warnings: [] };
      case "SGC":
        return { field: "condition-18-price", meaning: "SGC 10", companySpecific: true, warnings: [] };
      default:
        return {
          field: null,
          meaning: null,
          companySpecific: false,
          warnings: [
            "Grade 10 is company-specific. Provide the grading company (PSA/BGS/CGC/SGC) to select the correct value. See nearby values."
          ]
        };
    }
  }
  if (isOneOf(grade, [9, 9])) {
    return {
      field: "graded-price",
      meaning: "General Grade 9 market value",
      companySpecific: false,
      warnings: [
        "PriceCharting provides a general Grade 9 value, not a company-specific Grade 9 value. Do not treat this as a PSA/CGC/BGS/SGC-specific Grade 9."
      ]
    };
  }
  if (isOneOf(grade, [9.5])) {
    return { field: "box-only-price", meaning: "General Grade 9.5 market value", companySpecific: false, warnings: [] };
  }
  if (isOneOf(grade, [8, 8.5])) {
    return { field: "new-price", meaning: "Grade 8 / 8.5 market value", companySpecific: false, warnings: [] };
  }
  if (isOneOf(grade, [7, 7.5])) {
    return { field: "cib-price", meaning: "Grade 7 / 7.5 market value", companySpecific: false, warnings: [] };
  }
  return { field: null, meaning: null, companySpecific: false, warnings: [] };
}
function pickComicField(grade) {
  if (isOneOf(grade, [10, 10])) return { field: "bgs-10-price", meaning: "Comic Grade 10.0", companySpecific: false, warnings: [] };
  if (isOneOf(grade, [9.8])) return { field: "manual-only-price", meaning: "Comic Grade 9.8", companySpecific: false, warnings: [] };
  if (isOneOf(grade, [9.4])) return { field: "condition-17-price", meaning: "Comic Grade 9.4", companySpecific: false, warnings: [] };
  if (isOneOf(grade, [9.2])) return { field: "box-only-price", meaning: "Comic Grade 9.2", companySpecific: false, warnings: [] };
  if (isOneOf(grade, [8, 8.5])) return { field: "graded-price", meaning: "Comic Grade 8.0 / 8.5", companySpecific: false, warnings: [] };
  if (isOneOf(grade, [6, 6.5])) return { field: "new-price", meaning: "Comic Grade 6.0 / 6.5", companySpecific: false, warnings: [] };
  if (isOneOf(grade, [4, 4.5])) return { field: "cib-price", meaning: "Comic Grade 4.0 / 4.5", companySpecific: false, warnings: [] };
  return { field: null, meaning: null, companySpecific: false, warnings: [] };
}
function getValueForRequestedGrade(product, gradingCompany, grade, opts = {}) {
  const category = opts.category ?? inferPriceCategoryFromProduct(product);
  const nearby = buildAvailableValues(product, category);
  if (grade === null || grade === void 0) {
    const field = "loose-price";
    const pennies2 = px(product, field);
    return {
      value_pennies: pennies2,
      value_dollars: dollars(pennies2),
      field_used: pennies2 === null ? null : field,
      field_meaning: "Ungraded",
      company_specific: false,
      is_estimate: false,
      warnings: pennies2 === null ? ["PriceCharting has no ungraded value for this product."] : [],
      nearby_values: nearby
    };
  }
  let pick;
  if (category === "card") pick = pickCardField(gradingCompany, grade);
  else if (category === "comic") pick = pickComicField(grade);
  else {
    return {
      value_pennies: null,
      value_dollars: null,
      field_used: null,
      field_meaning: null,
      company_specific: false,
      is_estimate: false,
      warnings: [
        `No documented PriceCharting grade mapping exists for category "${category}". The exact-grade value is null; see nearby values for available fields.`
      ],
      nearby_values: nearby
    };
  }
  if (pick.field === null) {
    if (opts.enableEstimation) {
      const est = interpolateGrade(product, category, grade);
      if (est) {
        return {
          value_pennies: est.pennies,
          value_dollars: dollars(est.pennies),
          field_used: null,
          field_meaning: `Interpolated estimate for grade ${grade} (between ${est.lowerLabel} and ${est.upperLabel})`,
          company_specific: false,
          is_estimate: true,
          warnings: [
            `Grade ${grade} is not a direct PriceCharting field. This is an INTERPOLATED ESTIMATE, not an official PriceCharting value.`
          ],
          nearby_values: nearby
        };
      }
    }
    return {
      value_pennies: null,
      value_dollars: null,
      field_used: null,
      field_meaning: null,
      company_specific: false,
      is_estimate: false,
      warnings: [
        `PriceCharting does not provide a direct value for grade ${grade}${gradingCompany ? ` (${gradingCompany})` : ""}. Value is null; see nearby available grades.`,
        ...pick.warnings
      ],
      nearby_values: nearby
    };
  }
  const pennies = px(product, pick.field);
  const warnings = [...pick.warnings];
  if (pennies === null) {
    warnings.push(
      `PriceCharting has no value in field "${pick.field}" (${pick.meaning}) for this product. Value is null \u2014 not substituted from another grade.`
    );
  }
  return {
    value_pennies: pennies,
    value_dollars: dollars(pennies),
    field_used: pennies === null ? null : pick.field,
    field_meaning: pick.meaning,
    company_specific: pick.companySpecific,
    is_estimate: false,
    warnings,
    nearby_values: nearby
  };
}
function interpolateGrade(product, category, grade) {
  const anchors = category === "card" ? [
    { grade: 7, field: "cib-price", label: "Grade 7" },
    { grade: 8, field: "new-price", label: "Grade 8" },
    { grade: 9, field: "graded-price", label: "Grade 9" },
    { grade: 9.5, field: "box-only-price", label: "Grade 9.5" },
    { grade: 10, field: "manual-only-price", label: "Grade 10 (PSA)" }
  ] : category === "comic" ? [
    { grade: 4, field: "cib-price", label: "4.0" },
    { grade: 6, field: "new-price", label: "6.0" },
    { grade: 8, field: "graded-price", label: "8.0" },
    { grade: 9.2, field: "box-only-price", label: "9.2" },
    { grade: 9.4, field: "condition-17-price", label: "9.4" },
    { grade: 9.8, field: "manual-only-price", label: "9.8" },
    { grade: 10, field: "bgs-10-price", label: "10.0" }
  ] : [];
  const withValues = anchors.map((a) => ({ ...a, pennies: px(product, a.field) })).filter((a) => a.pennies !== null);
  let lower = null;
  let upper = null;
  for (const a of withValues) {
    if (a.grade <= grade && (!lower || a.grade > lower.grade)) lower = a;
    if (a.grade >= grade && (!upper || a.grade < upper.grade)) upper = a;
  }
  if (!lower || !upper || lower.grade === upper.grade) return null;
  const ratio = (grade - lower.grade) / (upper.grade - lower.grade);
  const pennies = Math.round(lower.pennies + ratio * (upper.pennies - lower.pennies));
  return { pennies, lowerLabel: lower.label, upperLabel: upper.label };
}

// src/server/pricecharting/handler.ts
function httpStatusFor(code) {
  switch (code) {
    case "AUTHENTICATION_ERROR":
    case "SUBSCRIPTION_REQUIRED":
      return 502;
    // upstream/config problem — do not leak specifics to the browser
    case "RATE_LIMITED":
      return 429;
    case "MISSING_PARAMETER":
    case "INVALID_PARAMETER":
    case "VALIDATION_ERROR":
      return 400;
    case "PRODUCT_NOT_FOUND":
      return 404;
    case "TIMEOUT":
      return 504;
    default:
      return 500;
  }
}
function toGradingCompany(grader) {
  if (!grader) return void 0;
  const g = grader.trim().toUpperCase();
  if (g === "PSA" || g === "BGS" || g === "CGC" || g === "SGC") return g;
  return "OTHER";
}
function toGradeNumber(grade) {
  if (grade === void 0 || grade === null || grade === "") return void 0;
  const n = typeof grade === "number" ? grade : Number(String(grade).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : void 0;
}
function toYear(year) {
  if (year === void 0 || year === null || year === "") return void 0;
  const n = typeof year === "number" ? year : Number(String(year).replace(/[^0-9]/g, "").slice(0, 4));
  return Number.isFinite(n) && n > 0 ? n : void 0;
}
function toCardInput(input) {
  return {
    category: "trading_card",
    card_name: input.card_name?.trim() || void 0,
    set: input.set?.trim() || void 0,
    card_number: input.card_number?.trim() || void 0,
    year: toYear(input.year),
    language: input.language?.trim() || void 0,
    variant: input.variation?.trim() || void 0,
    grading_company: toGradingCompany(input.grader),
    grade: toGradeNumber(input.grade)
  };
}
function levelFor(score) {
  if (score >= 95) return "Exact";
  if (score >= 85) return "High";
  if (score >= 70) return "Probable";
  if (score >= 50) return "Low";
  return "Unresolved";
}
function statusFor(score, disqualified) {
  if (disqualified || score < 50) return "no_match";
  if (score >= 95) return "exact";
  if (score >= 70) return "likely";
  return "unverified";
}
function numberOrNull(v) {
  if (v === null || v === void 0 || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
function makeClient(deps) {
  return new PriceChartingClient({
    fetch: deps.fetch,
    clock: deps.clock,
    logger: deps.logger ?? nullLogger,
    tokenProvider: deps.tokenProvider
  });
}
function errorBody(err) {
  const pcErr = isPriceChartingError(err) ? err : new PriceChartingError("UNKNOWN_API_ERROR", "An unexpected error occurred.", { cause: err });
  return pcErr.toJSON();
}
async function handlePriceChartingRequest(input, deps) {
  const action = input.action ?? "search";
  try {
    const client = makeClient(deps);
    if (action === "value") {
      return await handleValue(client, input);
    }
    return await handleSearch(client, input);
  } catch (err) {
    const body = errorBody(err);
    return { statusCode: httpStatusFor(body.error_code), body };
  }
}
async function handleSearch(client, input) {
  const item = toCardInput(input);
  const query = buildSearchQuery(item);
  if (!query) {
    throw new PriceChartingError("MISSING_PARAMETER", "Provide at least a card name, set, or card number to search.");
  }
  let products;
  try {
    products = await searchProducts(client, query);
  } catch (err) {
    if (isPriceChartingError(err) && err.code === "PRODUCT_NOT_FOUND") products = [];
    else throw err;
  }
  const scored = products.map((p) => scoreCandidate(item, p)).sort((a, b) => b.score - a.score);
  const grader = item.grading_company;
  const grade = item.grade ?? null;
  const candidates = scored.slice(0, 5).map((s) => {
    const lookup = getValueForRequestedGrade(s.product, grader, grade, { category: "card" });
    return {
      product_id: s.product.pricecharting_id,
      product_name: s.product.name,
      console_or_category: s.product.console_or_category,
      confidence_score: s.disqualified ? Math.min(s.score, 40) : s.score,
      match_status: statusFor(s.score, s.disqualified),
      grade_field: lookup.field_used,
      guide_value_cents: lookup.value_pennies,
      company_specific: lookup.company_specific,
      conflicts: s.conflicts
    };
  });
  const eligible = scored.filter((s) => !s.disqualified);
  const top = eligible[0];
  const runnerUp = eligible[1];
  let confidence = top ? top.score : 0;
  if (top && runnerUp && top.score - runnerUp.score < 8) confidence = Math.min(confidence, 68);
  if (top && top.conflicts.length > 0) confidence = Math.max(0, confidence - 20);
  const threshold = requiresHighConfidence(item) ? 85 : 70;
  const requiresConfirmation = confidence < threshold;
  const body = {
    status: "success",
    action: "search",
    query,
    confidence_score: confidence,
    confidence_level: levelFor(confidence),
    requires_confirmation: requiresConfirmation,
    // Never auto-confirm the first result: only surface an id when the gate clears.
    auto_confirmed_product_id: !requiresConfirmation && top ? top.product.pricecharting_id : null,
    candidates,
    warnings: [
      "Values are the Current PriceCharting Guide Value \u2014 not a last-sold, eBay-sold, or confirmed sale price."
    ]
  };
  return { statusCode: 200, body };
}
async function handleValue(client, input) {
  const productId = input.product_id?.trim();
  if (!productId) {
    throw new PriceChartingError("MISSING_PARAMETER", "product_id is required to retrieve a verified value.");
  }
  const grader = toGradingCompany(input.grader);
  const grade = toGradeNumber(input.grade) ?? null;
  const raw = await client.request({ endpoint: "product", method: "GET", params: { id: productId } });
  const product = normalizeProduct(raw);
  if (!product.pricecharting_id) {
    throw new PriceChartingError("PRODUCT_NOT_FOUND", `No product found for id ${productId}.`);
  }
  void getProductById;
  const salesVolume = numberOrNull(
    raw["sales-volume"] ?? raw["sale-volume"] ?? raw["salesVolume"] ?? raw["sales_volume"]
  );
  const lookup = getValueForRequestedGrade(product, grader, grade, { category: "card" });
  const availableCents = {};
  for (const [k, v] of Object.entries(lookup.nearby_values)) {
    availableCents[k] = v === null ? null : Math.round(v * 100);
  }
  const body = {
    status: "success",
    action: "value",
    product_id: product.pricecharting_id,
    product_name: product.name,
    console_or_category: product.console_or_category,
    grade_field: lookup.field_used,
    guide_value_cents: lookup.value_pennies,
    company_specific: lookup.company_specific,
    is_estimate: lookup.is_estimate,
    sales_volume: salesVolume,
    available_values_cents: availableCents,
    warnings: [
      "Current PriceCharting Guide Value \u2014 not a last-sold, eBay-sold, or confirmed historical sale.",
      ...lookup.warnings
    ]
  };
  return { statusCode: 200, body };
}
export {
  handlePriceChartingRequest
};
