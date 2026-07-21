/**
 * Market query generation. Every query is derived from the ONE canonical
 * CardIdentity, so PriceCharting and eBay searches stay consistent with the
 * identity engine instead of re-parsing fields.
 */

import type { CardIdentity } from "@/lib/identity/identity";

function tokens(...parts: Array<string | null | undefined>): string[] {
  return parts.map((p) => (p ?? "").trim()).filter(Boolean);
}

/**
 * PriceCharting search query — the CARD identity (name, set, number, variation).
 * Grade is never in the query; PriceCharting returns a product whose tiers hold
 * the per-grade values.
 */
export function priceChartingQuery(identity: CardIdentity): string {
  return tokens(identity.card_name, identity.set, identity.card_number, identity.variation).join(" ").replace(/\s+/g, " ").trim();
}

/**
 * eBay EXACT-match query for a specific specimen: the card plus the grader and
 * grade, so completed sales returned are the same card at the same tier. The
 * card name is quoted to reduce noise.
 */
export function ebayExactQuery(identity: CardIdentity): string {
  const base = tokens(identity.card_name).map((t) => `"${t}"`);
  const rest = tokens(identity.set, identity.card_number, identity.language, identity.variation);
  const specimen = tokens(identity.grader, identity.grade);
  return [...base, ...rest, ...specimen].join(" ").replace(/\s+/g, " ").trim();
}

/**
 * eBay COMPATIBLE query — the same card WITHOUT the grade constraint, to gather
 * the card across tiers (raw + all grades) for tier-relative context. Excludes
 * common lot/proxy noise.
 */
export function ebayCompatibleQuery(identity: CardIdentity): string {
  const base = tokens(identity.card_name).map((t) => `"${t}"`);
  const rest = tokens(identity.set, identity.card_number, identity.language);
  const excludes = ["-lot", "-proxy", "-custom", "-digital"];
  return [...base, ...rest, ...excludes].join(" ").replace(/\s+/g, " ").trim();
}
