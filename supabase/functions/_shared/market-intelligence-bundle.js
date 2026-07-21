// AUTO-GENERATED — do not edit. Source: src/server/market-intelligence/engine.ts
// Regenerate with: node scripts/build-market-intelligence-edge-bundle.mjs


// src/lib/market/grade-tier.ts
var GRADE_TIER_LABELS = {
  raw: "Raw / Ungraded",
  grade_1: "Grade 1",
  grade_2: "Grade 2",
  grade_3: "Grade 3",
  grade_4: "Grade 4",
  grade_5: "Grade 5",
  grade_6: "Grade 6",
  grade_7: "Grade 7",
  grade_8: "Grade 8",
  grade_9: "Grade 9",
  grade_9_5: "Grade 9.5",
  grade_10: "Grade 10",
  pristine_10: "Pristine 10",
  black_label_10: "Black Label 10",
  unknown: "Unknown"
};
function numericGrade(grade) {
  const m = grade.trim().match(/\d{1,2}(?:\.\d)?/);
  return m ? Number(m[0]) : null;
}
function mapGradeToTier(grader, grade, gradeLabel) {
  const g = (grade ?? "").trim();
  if (!g && !(grader ?? "").trim()) return "raw";
  const n = numericGrade(g);
  if (n === null) return "unknown";
  const label = (gradeLabel ?? "").toLowerCase();
  if (n === 10) {
    if (/pristine/.test(label)) return "pristine_10";
    if (/black\s*label/.test(label)) return "black_label_10";
    return "grade_10";
  }
  if (n === 9.5) return "grade_9_5";
  if (Number.isInteger(n) && n >= 1 && n <= 9) return `grade_${n}`;
  return "unknown";
}

// src/lib/market/query.ts
function tokens(...parts) {
  return parts.map((p) => (p ?? "").trim()).filter(Boolean);
}
function priceChartingQuery(identity) {
  return tokens(identity.card_name, identity.set, identity.card_number, identity.variation).join(" ").replace(/\s+/g, " ").trim();
}
function ebayExactQuery(identity) {
  const base = tokens(identity.card_name).map((t) => `"${t}"`);
  const rest = tokens(identity.set, identity.card_number, identity.language, identity.variation);
  const specimen = tokens(identity.grader, identity.grade);
  return [...base, ...rest, ...specimen].join(" ").replace(/\s+/g, " ").trim();
}
function ebayCompatibleQuery(identity) {
  const base = tokens(identity.card_name).map((t) => `"${t}"`);
  const rest = tokens(identity.set, identity.card_number, identity.language);
  const excludes = ["-lot", "-proxy", "-custom", "-digital"];
  return [...base, ...rest, ...excludes].join(" ").replace(/\s+/g, " ").trim();
}

// src/lib/market/candidates.ts
function norm(v) {
  return v.toLowerCase().replace(/\s+/g, " ").trim();
}
function normNumber(v) {
  return v.toLowerCase().split("/").map((p) => p.replace(/[^0-9a-z]/g, "").replace(/^0+(?=[0-9a-z])/, "")).join("/");
}
function titleMatchesCard(identity, title) {
  const t = norm(title);
  const name = norm(identity.card_name);
  if (!name || !t.includes(name)) return false;
  const number = normNumber(identity.card_number);
  if (number) {
    const compact = t.replace(/\s+/g, "");
    if (!compact.includes(number.replace("/", "/")) && !t.includes(number)) return false;
  }
  return true;
}
function normalizeCandidate(raw, observedFallback) {
  const price = typeof raw.price_cents === "number" && Number.isFinite(raw.price_cents) && raw.price_cents > 0 ? Math.round(raw.price_cents) : null;
  if (price === null) return null;
  return {
    source: raw.source,
    kind: raw.sold ? "sale" : "listing",
    price_cents: price,
    currency: (raw.currency ?? "USD").toUpperCase(),
    observed_at: raw.observed_at ?? observedFallback,
    sold_at: raw.sold ? raw.sold_at ?? raw.observed_at ?? observedFallback : null,
    grade_tier: mapGradeToTier(raw.grader, raw.grade, raw.grade_label),
    match: "rejected",
    // set by classify()
    url: raw.url ?? null,
    title: raw.title ?? null
  };
}
function classifyPoint(identity, targetTier, point) {
  if (!point.title || !titleMatchesCard(identity, point.title)) return "rejected";
  return point.grade_tier === targetTier ? "exact" : "compatible";
}
function classifyCandidates(identity, targetTier, candidates, observedFallback) {
  const out = [];
  for (const raw of candidates) {
    const point = normalizeCandidate(raw, observedFallback);
    if (!point) continue;
    out.push({ ...point, match: classifyPoint(identity, targetTier, point) });
  }
  return out;
}

// src/lib/market/listings.ts
function separateMarket(points) {
  const sales = [];
  const active = [];
  const compatible = [];
  for (const p of points) {
    if (p.match === "rejected") continue;
    if (p.match === "compatible") {
      compatible.push(p);
      continue;
    }
    (p.kind === "sale" ? sales : active).push(p);
  }
  return { sales, active, compatible };
}

// src/lib/market/summary.ts
function saleTime(p) {
  return p.sold_at ?? p.observed_at;
}
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}
function summarizeSales(sales) {
  const verified = sales.filter((p) => p.kind === "sale" && p.match === "exact");
  if (verified.length === 0) {
    return { count: 0, last_sale_cents: null, last_sale_at: null, highest_cents: null, lowest_cents: null, median_cents: null, average_cents: null };
  }
  const prices = verified.map((p) => p.price_cents);
  const byRecency = [...verified].sort((a, b) => saleTime(b).localeCompare(saleTime(a)));
  const last = byRecency[0];
  return {
    count: verified.length,
    last_sale_cents: last.price_cents,
    last_sale_at: saleTime(last),
    highest_cents: Math.max(...prices),
    lowest_cents: Math.min(...prices),
    median_cents: median(prices),
    average_cents: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)
  };
}

// src/lib/market/scores.ts
var DAY_MS = 864e5;
function daysBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / DAY_MS;
}
function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}
function liquidityScore(sales, asOf, windowDays = 90) {
  const verified = sales.filter((p) => p.kind === "sale" && p.match === "exact");
  const inWindow = verified.filter((p) => daysBetween(p.sold_at ?? p.observed_at, asOf) <= windowDays);
  if (inWindow.length === 0) return 0;
  const perMonth = inWindow.length / windowDays * 30;
  const velocity = clamp01(perMonth / 8);
  const mostRecent = Math.min(...inWindow.map((p) => daysBetween(p.sold_at ?? p.observed_at, asOf)));
  const recency = clamp01(1 - mostRecent / windowDays);
  return clamp01(0.7 * velocity + 0.3 * recency);
}
function marketConfidence(input) {
  const { summary, sourceCount } = input;
  if (summary.count === 0 || summary.median_cents === null) return 0;
  const sample = clamp01(summary.count / 12);
  const diversity = clamp01(sourceCount / 3);
  const spread = summary.highest_cents !== null && summary.lowest_cents !== null ? (summary.highest_cents - summary.lowest_cents) / Math.max(1, summary.median_cents) : 1;
  const tightness = clamp01(1 - spread / 2);
  return clamp01(0.5 * sample + 0.2 * diversity + 0.3 * tightness);
}

// src/lib/identity/completeness.ts
var RAW_RULES = [
  { field: "card_name", effect: "blocks_all", detail: "Without a card name, no market match is possible." },
  { field: "card_number", effect: "blocks_exact", detail: "A missing card number generally blocks exact-card matching; results may include other cards from the set." },
  { field: "language", effect: "downgrades_exact", detail: "Missing language may downgrade exact matching when language affects price." },
  { field: "variation", effect: "downgrades_exact", detail: "Missing variation may downgrade exact matching if printing variants exist." },
  { field: "finish", effect: "downgrades_exact", detail: "Missing finish may downgrade exact matching if foil/holo finishes vary." },
  { field: "certification_number", effect: "irrelevant", detail: "A certification number is not relevant to raw-card valuation." }
];
var CERTIFIED_RULES = [
  { field: "card_name", effect: "blocks_all", detail: "Without a card name, no market match is possible." },
  { field: "card_number", effect: "blocks_exact", detail: "A missing card number generally blocks exact-card matching; results may include other cards from the set." },
  { field: "language", effect: "downgrades_exact", detail: "Missing language may downgrade exact matching when language affects price." },
  { field: "variation", effect: "downgrades_exact", detail: "Missing variation may downgrade exact matching if printing variants exist." },
  { field: "finish", effect: "downgrades_exact", detail: "Missing finish may downgrade exact matching if foil/holo finishes vary." },
  { field: "certification_number", effect: "irrelevant", detail: "A missing certification number affects physical-specimen verification, not card valuation." }
];
function present(value) {
  if (value === null || value === void 0) return false;
  return String(value).trim().length > 0;
}
function assessIdentityCompleteness(identity, kind) {
  const rules = kind === "raw" ? RAW_RULES : CERTIFIED_RULES;
  const notes = [];
  const missing = [];
  let hasBlocking = false;
  let hasDowngrade = false;
  for (const rule of rules) {
    if (present(identity[rule.field])) continue;
    notes.push({ field: rule.field, effect: rule.effect, detail: rule.detail });
    if (rule.effect === "irrelevant") continue;
    missing.push(rule.field);
    if (rule.effect === "blocks_all" || rule.effect === "blocks_exact") hasBlocking = true;
    if (rule.effect === "downgrades_exact") hasDowngrade = true;
  }
  const status = hasBlocking ? "ambiguous" : hasDowngrade ? "partial" : "complete";
  return { status, missing, notes };
}

// src/lib/identity/identity.ts
var CARD_IDENTITY_FIELDS = [
  "card_name",
  "set",
  "set_code",
  "card_number",
  "language",
  "rarity",
  "finish",
  "variation",
  "year",
  "manufacturer"
];
var text = (v) => v === null || v === void 0 ? "" : String(v).trim();
function normText(v) {
  return v.toLowerCase().replace(/\s+/g, " ").trim();
}
function normYear(v) {
  const m = v.match(/\d{4}/);
  return m ? m[0] : "";
}
function normCardNumber(v) {
  return v.toLowerCase().split("/").map((part) => part.replace(/[^0-9a-z]/g, "").replace(/^0+(?=[0-9a-z])/, "")).join("/");
}
function normalizedFor(field, value) {
  if (field === "card_number") return normCardNumber(value);
  if (field === "year") return normYear(value);
  return normText(value);
}
function canonicalIdentityString(input) {
  return CARD_IDENTITY_FIELDS.map((field) => `${field}=${normalizedFor(field, text(input[field]))}`).join("|");
}
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function identityHash(input) {
  return sha256Hex(canonicalIdentityString(input));
}
function ebayQueryFor(input) {
  const parts = [text(input.card_name), text(input.set), text(input.card_number)];
  const grade = text(input.grade);
  const grader = text(input.grader);
  if (grader && grade) parts.push(`${grader} ${grade}`);
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
function priceChartingUrl(productId) {
  return productId ? `https://www.pricecharting.com/offers?product=${encodeURIComponent(productId)}` : "";
}
function normCert(value) {
  return value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}
function specimenKeyResult(identity, inventoryCode) {
  const cert = normCert(identity.certification_number);
  if (cert) return { status: "certified", key: `${identity.hash}:${normText(identity.grader)}:${cert}` };
  const code = (inventoryCode ?? "").trim().toUpperCase();
  if (code) return { status: "raw", key: `${identity.hash}:${code}` };
  return {
    status: "incomplete",
    key: null,
    reason: "A specimen key requires a certification number (certified) or an inventory code (raw); neither was provided, so the physical specimen is not uniquely identifiable."
  };
}
async function buildIdentity(input) {
  const productId = text(input.pricecharting_product_id);
  return {
    card_name: text(input.card_name),
    set: text(input.set),
    set_code: text(input.set_code),
    card_number: text(input.card_number),
    language: text(input.language),
    rarity: text(input.rarity),
    finish: text(input.finish),
    variation: text(input.variation),
    year: normYear(text(input.year)),
    manufacturer: text(input.manufacturer),
    grader: text(input.grader),
    grade: text(input.grade),
    grade_label: text(input.grade_label),
    certification_number: text(input.certification_number),
    population: input.population ?? {},
    pricecharting_product_id: productId,
    pricecharting_url: priceChartingUrl(productId),
    ebay_query: ebayQueryFor(input),
    hash: await identityHash(input)
  };
}

// src/lib/market/adapters/cache-key.ts
function cacheKey(source, identityHash2, params = {}) {
  const encoded = Object.keys(params).sort().map((k) => `${k}=${String(params[k])}`).join("&");
  return encoded ? `${source}|${identityHash2}|${encoded}` : `${source}|${identityHash2}`;
}
var MARKET_QUERY_VERSION = 2;
function marketCacheKey(d) {
  if (d.scope === "owner-private" && !(d.ownerId ?? "").trim()) {
    throw new Error(
      "marketCacheKey: owner-private scope requires an ownerId — private seller data must never be shared across users via cache reuse."
    );
  }
  const providers = [...d.providers].map((p) => p.trim()).filter(Boolean).sort();
  const parts = [
    `v=${d.queryVersion ?? MARKET_QUERY_VERSION}`,
    `scope=${d.scope}`,
    `id=${d.identityHash}`,
    `tier=${d.tier}`,
    `providers=${providers.join(",")}`
  ];
  if (d.scope === "owner-private") parts.push(`owner=${(d.ownerId ?? "").trim()}`);
  return parts.join("|");
}

// src/lib/market/adapters/pricecharting.ts
function mapPriceCharting(response, retrievedAt) {
  return (response.tiers ?? []).filter((t) => typeof t.price_cents === "number" && t.price_cents > 0).map((t) => ({
    source: "pricecharting",
    title: response.product_name,
    price_cents: t.price_cents,
    currency: "USD",
    url: response.url ?? null,
    sold: true,
    // PriceCharting values are realized-sale aggregates
    sold_at: retrievedAt,
    observed_at: retrievedAt,
    grader: t.grader ?? null,
    grade: t.grade ?? null,
    grade_label: t.grade_label ?? null
  }));
}

// src/lib/market/adapters/ebay-active.ts
function toCents(value) {
  if (value === null || value === void 0) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}
function mapEbayActive(response, retrievedAt) {
  return (response.itemSummaries ?? []).map((item) => ({
    source: "ebay_active",
    title: item.title ?? null,
    price_cents: toCents(item.price?.value),
    currency: (item.price?.currency ?? "USD").toUpperCase(),
    url: item.itemWebUrl ?? null,
    sold: false,
    sold_at: null,
    observed_at: retrievedAt
  })).filter((c) => c.price_cents !== null);
}

// src/lib/market/adapters/ebay-sold.ts
function toCents2(value) {
  if (value === null || value === void 0) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}
function mapEbaySold(response, retrievedAt) {
  const out = [];
  for (const order of response.orders ?? []) {
    if (order.orderFulfillmentStatus && !/fulfilled|paid|complete/i.test(order.orderFulfillmentStatus)) continue;
    for (const item of order.lineItems ?? []) {
      const cents = toCents2(item.lineItemCost?.value);
      if (cents === null) continue;
      out.push({
        source: "ebay_sold",
        title: item.title ?? null,
        price_cents: cents,
        currency: (item.lineItemCost?.currency ?? "USD").toUpperCase(),
        url: null,
        sold: true,
        sold_at: item.soldAt ?? retrievedAt,
        observed_at: retrievedAt
      });
    }
  }
  return out;
}

// src/lib/market/adapters/manual.ts
function mapManualComps(comps, retrievedAt) {
  return comps.filter((c) => typeof c.price_cents === "number" && c.price_cents > 0).map((c) => ({
    source: "manual",
    title: c.title ?? null,
    price_cents: Math.round(c.price_cents),
    currency: (c.currency ?? "USD").toUpperCase(),
    url: c.url ?? null,
    sold: true,
    sold_at: c.sold_at ?? retrievedAt,
    observed_at: retrievedAt,
    grader: c.grader ?? null,
    grade: c.grade ?? null,
    grade_label: c.grade_label ?? null
  }));
}

// src/lib/pricecharting/grade-mapping.ts
function fieldToCardTier(field) {
  switch (field) {
    case "loose-price":
      return { key: "ungraded", label: "Ungraded" };
    case "cib-price":
      return { key: "grade_7_to_7_5", label: "Grade 7–7.5" };
    case "new-price":
      return { key: "grade_8_to_8_5", label: "Grade 8–8.5" };
    case "graded-price":
      return { key: "grade_9_general", label: "Grade 9 (general)" };
    case "box-only-price":
      return { key: "grade_9_5_general", label: "Grade 9.5 (general)" };
    case "manual-only-price":
      return { key: "psa_10", label: "PSA 10" };
    case "bgs-10-price":
      return { key: "bgs_10", label: "BGS 10" };
    case "condition-17-price":
      return { key: "cgc_10", label: "CGC 10" };
    case "condition-18-price":
      return { key: "sgc_10", label: "SGC 10" };
    case "condition-19-price":
      return { key: "cgc_10_pristine", label: "CGC 10 Pristine" };
    case "condition-20-price":
      return { key: "bgs_10_black_label", label: "BGS 10 Black Label" };
    case "condition-21-price":
      return { key: "tag_10", label: "TAG 10" };
    case "condition-22-price":
      return { key: "ace_10", label: "ACE 10" };
    default:
      return { key: null, label: null };
  }
}
var CARD_TIER_FIELD_SPECS = [
  { field: "loose-price", grader: null, grade: null },
  // Ungraded
  { field: "cib-price", grader: null, grade: "7" },
  // Grade 7–7.5
  { field: "new-price", grader: null, grade: "8" },
  // Grade 8–8.5
  { field: "graded-price", grader: null, grade: "9" },
  // GENERAL Grade 9
  { field: "box-only-price", grader: null, grade: "9.5" },
  // Grade 9.5 (general)
  { field: "manual-only-price", grader: "PSA", grade: "10" },
  // PSA 10
  { field: "bgs-10-price", grader: "BGS", grade: "10" },
  // BGS 10
  { field: "condition-17-price", grader: "CGC", grade: "10" },
  // CGC 10
  { field: "condition-18-price", grader: "SGC", grade: "10" }
  // SGC 10
];
function priceChartingCardTiers(rawPrices) {
  const prices = rawPrices ?? {};
  return CARD_TIER_FIELD_SPECS.map((spec) => {
    const raw = prices[spec.field];
    const price_cents = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    const label = fieldToCardTier(spec.field).label;
    return { grader: spec.grader, grade: spec.grade, grade_label: label ?? spec.field, price_cents };
  });
}

// src/server/market-intelligence/engine.ts
var SOURCE_LABELS = {
  pricecharting: "PriceCharting",
  ebay_active: "eBay active listings",
  ebay_sold: "Connected-seller sales",
  population: "Population data",
  manual: "Operator comps"
};
function sourceLabel(source) {
  return SOURCE_LABELS[source] ?? source;
}
function statusFromErrorCode(code) {
  switch (code) {
    case "not_configured":
      return "not_configured";
    case "unauthorized":
      return "unauthorized";
    case "rate_limited":
      return "rate_limited";
    case "network_error":
      return "network_error";
    case "not_found":
      return "no_results";
    // 404 = no data, not a failure
    default:
      return "provider_error";
  }
}
function safeMessage(source, status, count) {
  const label = sourceLabel(source);
  switch (status) {
    case "success":
      return `${count} result${count === 1 ? "" : "s"} from ${label}.`;
    case "no_results":
      return `No matching results from ${label}.`;
    case "not_configured":
      return `${label} is not configured.`;
    case "unauthorized":
      return `${label} authorization failed.`;
    case "rate_limited":
      return `${label} is rate-limited; try again shortly.`;
    case "network_error":
      return `Could not reach ${label}.`;
    case "provider_error":
      return `${label} request failed.`;
  }
}
function deriveSourceState(result, exactCount) {
  const p = result.provenance;
  if (result.error) {
    const status2 = statusFromErrorCode(result.error.code);
    return {
      source: result.source,
      status: status2,
      query: p.query,
      retrieved_at: p.retrieved_at,
      candidate_count: 0,
      exact_count: 0,
      retryable: result.error.retryable,
      message: safeMessage(result.source, status2, 0)
    };
  }
  const count = result.candidates.length;
  const status = count === 0 ? "no_results" : "success";
  return {
    source: result.source,
    status,
    query: p.query,
    retrieved_at: p.retrieved_at,
    candidate_count: count,
    exact_count: exactCount,
    retryable: false,
    message: safeMessage(result.source, status, count)
  };
}
function buildMarketIntelligence(identity, targetTier, results, asOf) {
  const allPoints = [];
  const provenance = [];
  const gradeTiers = [];
  const sources = [];
  for (const result of results) {
    if (result.source === "pricecharting") {
      for (const c of result.candidates) {
        const tier = mapGradeToTier(c.grader, c.grade, c.grade_label);
        if (typeof c.price_cents === "number" && c.price_cents > 0) {
          gradeTiers.push({ tier, label: c.grade_label ?? GRADE_TIER_LABELS[tier], value_cents: c.price_cents, source: "pricecharting" });
        }
      }
      provenance.push({ ...result.provenance, exact_count: result.candidates.length });
      sources.push(deriveSourceState(result, result.candidates.length));
      continue;
    }
    const points = classifyCandidates(identity, targetTier, result.candidates, asOf);
    allPoints.push(...points);
    const exact = points.filter((p) => p.match === "exact").length;
    provenance.push({ ...result.provenance, exact_count: exact });
    sources.push(deriveSourceState(result, exact));
  }
  const identityCompleteness = assessIdentityCompleteness(
    identity,
    targetTier === "raw" ? "raw" : "certified"
  );
  const { sales, active } = separateMarket(allPoints);
  const summary = summarizeSales(sales);
  const lowestActive = active.length > 0 ? Math.min(...active.map((p) => p.price_cents)) : null;
  const sourcesWithSales = new Set(sales.map((p) => p.source)).size;
  return {
    identity_hash: identity.hash,
    grade_tier: targetTier,
    verified_sales: sales,
    active_listings: active,
    grade_tiers: gradeTiers,
    summary,
    last_sold_cents: summary.last_sale_cents,
    median_sold_cents: summary.median_cents,
    low_sold_cents: summary.lowest_cents,
    high_sold_cents: summary.highest_cents,
    lowest_active_cents: lowestActive,
    liquidity: liquidityScore(sales, asOf),
    confidence: marketConfidence({ summary, sourceCount: sourcesWithSales, asOf }),
    provenance,
    sources,
    identity_completeness: identityCompleteness,
    generated_at: asOf
  };
}
export {
  MARKET_QUERY_VERSION,
  assessIdentityCompleteness,
  buildIdentity,
  buildMarketIntelligence,
  cacheKey,
  deriveSourceState,
  ebayCompatibleQuery,
  ebayExactQuery,
  mapEbayActive,
  mapEbaySold,
  mapGradeToTier,
  mapManualComps,
  mapPriceCharting,
  marketCacheKey,
  priceChartingCardTiers,
  priceChartingQuery,
  specimenKeyResult
};
