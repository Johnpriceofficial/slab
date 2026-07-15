/**
 * Candidate normalization and exact/compatible/rejected classification.
 *
 * A raw source candidate is normalized into a canonical MarketDataPoint, then
 * classified against the target card identity + grade tier:
 *   - exact      — the same card AND the same grade tier
 *   - compatible — the same card at a DIFFERENT grade tier (tier-relative context)
 *   - rejected   — not the same card (or unusable)
 */

import type { CardIdentity } from "@/lib/identity/identity";
import { mapGradeToTier, type GradeTier } from "./grade-tier";
import type { MarketDataPoint, MatchClass, RawCandidate } from "./types";

function norm(v: string): string {
  return v.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Compact a card number for loose title matching (e.g. "004/102" -> "4/102"). */
function normNumber(v: string): string {
  return v.toLowerCase().split("/").map((p) => p.replace(/[^0-9a-z]/g, "").replace(/^0+(?=[0-9a-z])/, "")).join("/");
}

/**
 * Does a listing title plausibly refer to this card? Requires the card name and,
 * when the identity has one, the card number to appear. Conservative on purpose:
 * a false "exact" pollutes the sale set more than a missed listing.
 */
export function titleMatchesCard(identity: CardIdentity, title: string): boolean {
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

/** Normalize a raw candidate into a canonical point, or null if unusable. */
export function normalizeCandidate(raw: RawCandidate, observedFallback: string): MarketDataPoint | null {
  const price = typeof raw.price_cents === "number" && Number.isFinite(raw.price_cents) && raw.price_cents > 0 ? Math.round(raw.price_cents) : null;
  if (price === null) return null;
  return {
    source: raw.source,
    kind: raw.sold ? "sale" : "listing",
    price_cents: price,
    currency: (raw.currency ?? "USD").toUpperCase(),
    observed_at: raw.observed_at ?? observedFallback,
    sold_at: raw.sold ? (raw.sold_at ?? raw.observed_at ?? observedFallback) : null,
    grade_tier: mapGradeToTier(raw.grader, raw.grade, raw.grade_label),
    match: "rejected", // set by classify()
    url: raw.url ?? null,
    title: raw.title ?? null,
  };
}

/** Classify a normalized point against the target card + tier. */
export function classifyPoint(identity: CardIdentity, targetTier: GradeTier, point: MarketDataPoint): MatchClass {
  if (!point.title || !titleMatchesCard(identity, point.title)) return "rejected";
  return point.grade_tier === targetTier ? "exact" : "compatible";
}

/** Normalize + classify a batch, dropping unusable candidates. */
export function classifyCandidates(
  identity: CardIdentity,
  targetTier: GradeTier,
  candidates: RawCandidate[],
  observedFallback: string,
): MarketDataPoint[] {
  const out: MarketDataPoint[] = [];
  for (const raw of candidates) {
    const point = normalizeCandidate(raw, observedFallback);
    if (!point) continue;
    out.push({ ...point, match: classifyPoint(identity, targetTier, point) });
  }
  return out;
}
