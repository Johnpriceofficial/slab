// Pure helpers for turning a slab into an eBay listing's identity: a canonical
// SKU, an optimized (<=80 char) title, and its stored image paths. Kept pure and
// separate so they are unit-tested without a browser or network, and reused by
// the EbaySellerPanel when preparing/publishing a listing.

// Fields these helpers read — a subset of Slab, so tests can pass minimal objects.
export interface ListingSlab {
  card_name?: string | null;
  set_name?: string | null;
  card_number?: string | null;
  year?: number | null;
  language?: string | null;
  variation?: string | null;
  rarity?: string | null;
  grader?: string | null;
  grade?: string | null;
  grade_label?: string | null;
  front_image_path?: string | null;
  back_image_path?: string | null;
}

const clean = (s: unknown): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

// Word-boundary phrase containment (case-insensitive), padded so "Holo" is found
// inside "Rare Holo" but not inside "Holograph".
const includesPhrase = (text: string, phrase: string): boolean =>
  !!phrase && ` ${text.toLowerCase()} `.includes(` ${phrase.toLowerCase()} `);

// NOTE: the SKU is intentionally NOT generated here — it is the single canonical
// cross-marketplace value from marketplace-sku.ts (canonicalMarketplaceSku).

/**
 * An optimized eBay title within eBay's 80-char cap. Language is included when
 * known; overlapping rarity/variation phrases are deduplicated (no "Holo Rare
 * Holo", no doubled "Super Rare"). The card name and the grade (grader +
 * designation + grade) are always kept; lower-value tokens drop in order
 * (rarity → variation → # → year → set → language) until it fits, then a final
 * hard truncate guards the cap.
 */
export function ebayListingTitle(slab: ListingSlab, max = 80): string {
  const cardName = clean(slab.card_name) || "Graded Card";
  const grade = [clean(slab.grader), clean(slab.grade_label), clean(slab.grade)].filter(Boolean).join(" ");
  const year = typeof slab.year === "number" ? String(slab.year) : "";
  const language = clean(slab.language);
  const set = clean(slab.set_name);
  const num = clean(slab.card_number) ? `#${clean(slab.card_number)}` : "";

  // Deduplicate variation vs rarity: when one phrase contains the other, keep the
  // more specific (longer) one and drop the redundant one.
  let variation = clean(slab.variation);
  let rarity = clean(slab.rarity);
  if (variation && rarity) {
    if (includesPhrase(variation, rarity)) rarity = "";
    else if (includesPhrase(rarity, variation)) variation = "";
  }

  const build = (skip: ReadonlySet<string>): string => {
    const lead = ([["year", year], ["lang", language], ["set", set], ["name", cardName], ["num", num]] as const)
      .filter(([k, v]) => v && !skip.has(k))
      .map(([, v]) => v)
      .join(" ").replace(/\s+/g, " ").trim();
    let out = lead;
    // Only append variation/rarity if not already represented in the title.
    if (variation && !skip.has("var") && !includesPhrase(out, variation)) out = `${out} ${variation}`.trim();
    if (rarity && !skip.has("rarity") && !includesPhrase(out, rarity)) out = `${out} ${rarity}`.trim();
    return (grade ? `${out} ${grade}` : out).replace(/\s+/g, " ").trim();
  };

  const dropOrder = ["rarity", "var", "num", "year", "set", "lang"]; // name + grade never dropped
  const skip = new Set<string>();
  let title = build(skip);
  for (const key of dropOrder) {
    if (title.length <= max) break;
    skip.add(key);
    title = build(skip);
  }
  return title.length <= max ? title : title.slice(0, max).trim();
}

/** Stored image paths for a slab, front first — the inputs to signed-URL resolution. */
export function slabImagePaths(slab: ListingSlab): string[] {
  return [slab.front_image_path, slab.back_image_path].filter((p): p is string => typeof p === "string" && p.trim().length > 0);
}

/** Names of the category aspects eBay marks REQUIRED (getItemAspectsForCategory). */
export function requiredAspectNames(categoryAspects: unknown): string[] {
  const aspects = (categoryAspects as { aspects?: unknown } | null)?.aspects;
  if (!Array.isArray(aspects)) return [];
  return aspects
    .filter((a) => (a as { aspectConstraint?: { aspectRequired?: boolean } })?.aspectConstraint?.aspectRequired === true)
    .map((a) => String((a as { localizedAspectName?: unknown })?.localizedAspectName ?? "").trim())
    .filter(Boolean);
}

/** Human-readable allowed condition values (getItemConditionPolicies), for display. */
export function conditionPolicyValues(conditionPolicies: unknown): string[] {
  const policies = (conditionPolicies as { itemConditionPolicies?: unknown } | null)?.itemConditionPolicies;
  const first = Array.isArray(policies) ? policies[0] as { itemConditions?: unknown } : null;
  const conditions = first && Array.isArray(first.itemConditions) ? first.itemConditions as Array<Record<string, unknown>> : [];
  return conditions.map((c) => String(c.conditionDescription ?? c.conditionId ?? "").trim()).filter(Boolean);
}

export interface PublishReadinessInput {
  connected: boolean;
  preparedOk: boolean;
  preparedFailedResource: string | null;
  sku: string;
  title: string;
  description: string;
  price: number;
  currency: string;
  categoryId: string;
  condition: string;
  locationKey: string;
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
  locationKeys: readonly string[];
  fulfillmentPolicyIds: readonly string[];
  paymentPolicyIds: readonly string[];
  returnPolicyIds: readonly string[];
  imageCount: number;
  requiredAspects: readonly string[];
  providedAspects: Record<string, unknown>;
}

/**
 * The COMPLETE client-side publish gate. Publish is allowed only when every
 * blocker is clear — the server's INCOMPLETE_LISTING is a backstop, never the
 * primary gate. Unsupported required category aspects visibly block publish.
 */
export function evaluatePublishReadiness(i: PublishReadinessInput): { canPublish: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (!i.connected) blockers.push("No connected eBay account");
  if (!i.preparedOk) blockers.push(i.preparedFailedResource ? `Requirements not loaded (${i.preparedFailedResource})` : "Load current eBay requirements first");
  if (!i.sku.trim()) blockers.push("Missing canonical SKU");
  const titleLen = i.title.trim().length;
  if (titleLen < 1 || titleLen > 80) blockers.push("Title must be 1–80 characters");
  if (!i.description.trim()) blockers.push("Description is required");
  if (!(Number.isFinite(i.price) && i.price > 0)) blockers.push("Price must be a positive number");
  if (i.currency !== "USD") blockers.push("Unsupported currency");
  if (!i.categoryId.trim()) blockers.push("Category ID is required");
  if (!i.condition.trim()) blockers.push("Condition is required");
  if (!i.locationKey || !i.locationKeys.includes(i.locationKey)) blockers.push("Select an inventory location from discovery");
  if (!i.fulfillmentPolicyId || !i.fulfillmentPolicyIds.includes(i.fulfillmentPolicyId)) blockers.push("Select a fulfillment policy from discovery");
  if (!i.paymentPolicyId || !i.paymentPolicyIds.includes(i.paymentPolicyId)) blockers.push("Select a payment policy from discovery");
  if (!i.returnPolicyId || !i.returnPolicyIds.includes(i.returnPolicyId)) blockers.push("Select a return policy from discovery");
  if (i.imageCount < 1) blockers.push("At least one front image is required");
  const missing = i.requiredAspects.filter((a) => !i.providedAspects[a]);
  if (missing.length) blockers.push(`Required category aspects not provided: ${missing.join(", ")}`);
  return { canPublish: blockers.length === 0, blockers };
}
