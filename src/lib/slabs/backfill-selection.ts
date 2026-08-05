/**
 * Pure candidate-selection and outcome-classification logic for the admin
 * valuation-backfill driver (scripts/backfill-valuations.ts), kept separate
 * from the script's I/O so the resume/skip rules are unit-testable — the same
 * split the detail-page refresh uses (pricing-refresh.ts) and the benchmark
 * runner uses (src/lib/benchmark).
 *
 * The driver REUSES refreshSlabPricing() from data.ts for the actual per-slab
 * work, so product resolution (auto-confirm-only linking), buildRefreshScalars
 * (a manual-provenance guide is never overwritten) and the atomic stale-guarded
 * apply_slab_pricing write are the library's own. Nothing here re-implements
 * matching or scalar logic. This module only decides:
 *   1. WHICH slabs a batch run touches, in a deterministic resume-safe order
 *      (inventory_number ascending; a slab that is already linked AND freshly
 *      priced is skipped, so an interrupted run continues where it stopped);
 *   2. HOW a refresh result is reported (linked / valued / skipped / conflict);
 *   3. WHEN an error message is an auth failure that must stop the whole run.
 */

/** The subset of a slab row the selection rules need. */
export interface BackfillSlabFields {
  id: string;
  inventory_number: number;
  archived_at?: string | null;
  pricecharting_product_id: string | null;
  /** Retrieval timestamp of the stored pricing. apply_slab_pricing updates it,
   *  and the DB trigger captures a valuation_snapshot whenever it changes — so
   *  it is the client-visible freshness key for "has a recent snapshot". */
  pricecharting_priced_at?: string | null;
  valuation_status?: string | null;
}

export interface BackfillSelectionOptions {
  /** Keep only slabs with no PriceCharting product link. */
  onlyUnlinked: boolean;
  /** Keep only slabs whose valuation_status is 'needs_review'. */
  onlyNeedsReview: boolean;
  /** A linked slab priced more recently than this many days ago is skipped. */
  maxAgeDays: number;
  /** Maximum number of slabs to process this run; the rest are deferred. */
  limit: number;
  /** "Now" as an ISO timestamp (injected so freshness is testable). */
  nowIso: string;
}

export type BackfillSkipReason =
  | "archived"
  | "fresh_valuation" // linked + recent snapshot → resume-safe skip
  | "not_unlinked" // --only-unlinked and the slab is already linked
  | "not_needs_review"; // --only-needs-review and the slab is not needs_review

export type BackfillDecision =
  | { action: "process"; api_calls: 1 | 2 }
  | { action: "skip"; reason: BackfillSkipReason };

/**
 * True when the stored pricing is younger than maxAgeDays. A missing or
 * unparseable timestamp is NOT fresh (the slab should be processed); a future
 * timestamp (clock skew) counts as fresh — the safe, non-spending direction.
 */
export function isFreshValuation(
  pricedAtIso: string | null | undefined,
  nowIso: string,
  maxAgeDays: number,
): boolean {
  if (!pricedAtIso) return false;
  const pricedAt = Date.parse(pricedAtIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(pricedAt) || !Number.isFinite(now)) return false;
  const ageMs = now - pricedAt;
  return ageMs < 0 ? true : ageMs < maxAgeDays * 86_400_000;
}

/**
 * Decide what a batch run should do with one slab. `api_calls` mirrors
 * refreshSlabPricing exactly: an already-linked slab is re-valued directly
 * (1 edge call), an unlinked slab needs search + value (2 edge calls).
 */
export function classifySlabForBackfill(
  slab: BackfillSlabFields,
  opts: BackfillSelectionOptions,
): BackfillDecision {
  if (slab.archived_at) return { action: "skip", reason: "archived" };
  const linked = Boolean(slab.pricecharting_product_id);
  if (opts.onlyUnlinked && linked) return { action: "skip", reason: "not_unlinked" };
  if (opts.onlyNeedsReview && slab.valuation_status !== "needs_review") {
    return { action: "skip", reason: "not_needs_review" };
  }
  if (linked && isFreshValuation(slab.pricecharting_priced_at, opts.nowIso, opts.maxAgeDays)) {
    return { action: "skip", reason: "fresh_valuation" };
  }
  return { action: "process", api_calls: linked ? 1 : 2 };
}

export interface BackfillSelection<T extends BackfillSlabFields> {
  /** Slabs to process THIS run, in inventory_number order, capped at limit. */
  candidates: Array<{ slab: T; api_calls: 1 | 2 }>;
  /** Slabs excluded by the skip rules, with the reason for each. */
  skipped: Array<{ slab: T; reason: BackfillSkipReason }>;
  /** Actionable slabs beyond the limit — the NEXT run's starting point. */
  deferred: number;
  /** Estimated PriceCharting-consuming edge calls for the selected candidates. */
  total_api_calls: number;
}

/**
 * Order the inventory deterministically (inventory_number ascending, id as a
 * stable tiebreak), classify every slab, and cap the actionable set at
 * opts.limit. Skips never consume the limit. Because a successful refresh
 * updates pricecharting_priced_at, re-running the same command after an
 * interruption skips the already-refreshed slabs and resumes where it stopped.
 */
export function selectBackfillCandidates<T extends BackfillSlabFields>(
  slabs: readonly T[],
  opts: BackfillSelectionOptions,
): BackfillSelection<T> {
  const ordered = [...slabs].sort(
    (a, b) => a.inventory_number - b.inventory_number || a.id.localeCompare(b.id),
  );
  const candidates: Array<{ slab: T; api_calls: 1 | 2 }> = [];
  const skipped: Array<{ slab: T; reason: BackfillSkipReason }> = [];
  let deferred = 0;
  let totalApiCalls = 0;
  for (const slab of ordered) {
    const decision = classifySlabForBackfill(slab, opts);
    if (decision.action === "skip") {
      skipped.push({ slab, reason: decision.reason });
      continue;
    }
    if (candidates.length >= opts.limit) {
      deferred += 1;
      continue;
    }
    candidates.push({ slab, api_calls: decision.api_calls });
    totalApiCalls += decision.api_calls;
  }
  return { candidates, skipped, deferred, total_api_calls: totalApiCalls };
}

/* ----------------------- refresh-result classification ------------------- */

/** The status values RefreshPricingResult can carry (see data.ts). */
export type RefreshStatus = "applied" | "stale" | "needs_confirmation" | "no_product" | "error";

export type BackfillOutcome = "linked" | "valued" | "skipped" | "conflict" | "error";

/**
 * Map a refreshSlabPricing result onto the batch-report vocabulary.
 * "linked" is reserved for the one mutating success an UNLINKED slab can have:
 * an auto-confirmed exact search match was linked and valued in the same
 * atomic write. An already-linked slab that applied is simply "valued".
 */
export function classifyRefreshOutcome(
  status: RefreshStatus,
  wasLinkedBefore: boolean,
): { outcome: BackfillOutcome; reason: string | null } {
  switch (status) {
    case "applied":
      return wasLinkedBefore
        ? { outcome: "valued", reason: null }
        : { outcome: "linked", reason: "auto_confirmed_match" };
    case "needs_confirmation":
      return { outcome: "conflict", reason: "needs_confirmation" };
    case "no_product":
      return { outcome: "skipped", reason: "no_match" };
    case "stale":
      return { outcome: "skipped", reason: "stale_write" };
    case "error":
      return { outcome: "error", reason: "error" };
  }
}

/* ----------------------------- auth failures ------------------------------ */

/**
 * True when an error message indicates the caller's credentials were rejected
 * (401/403, expired/invalid JWT, non-admin, RLS denial). The driver must STOP
 * the whole run on these — retrying other slabs with dead credentials would
 * only produce a wall of identical failures.
 *
 * Limitation: supabase-js functions.invoke collapses non-2xx responses into a
 * generic "non-2xx status code" message, which this cannot distinguish from a
 * server error — the driver therefore also preflights auth before the loop and
 * refuses tokens that would expire mid-run.
 */
const AUTH_FAILURE_RE =
  /(\b401\b|\b403\b|unauthori[sz]ed|not[\s_-]?authori[sz]ed|invalid\s+(?:jwt|token)|jwt\s+(?:expired|is\s+invalid|malformed)|token\s+is\s+expired|admin\s+access\s+required|permission\s+denied|access\s+denied)/i;

export function isAuthFailureMessage(message: string | null | undefined): boolean {
  return Boolean(message) && AUTH_FAILURE_RE.test(message as string);
}

/* ------------------------------ token expiry ------------------------------ */

/** Decode a JWT's `exp` (seconds since epoch) without verifying it. Returns
 *  null for anything unparseable — the caller treats that as "unknown". */
export function decodeJwtExpiry(jwt: string): number | null {
  const parts = (jwt ?? "").split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Rough wall-clock estimate for a run: the server spaces PriceCharting calls
 * ≥1 s apart (reserve_api_request_slot) and the driver adds ~1.1 s client-side
 * pacing, so ~1.2 s per API call plus fixed overhead is a safe upper bound.
 */
export function estimateRunSeconds(totalApiCalls: number): number {
  return Math.ceil(totalApiCalls * 1.2) + 30;
}
