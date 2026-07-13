/**
 * §5 Confirmed-product-id-first state machine.
 *
 * A user-confirmed PriceCharting product is NEVER silently unlinked or replaced
 * by a fresh fuzzy candidate. When a slab already carries a confirmed product id
 * we fetch THAT product first, validate it against the current slab identity, and
 * decide what to do — pure and fully testable so the exact flow is verifiable.
 *
 * Fuzzy search is permitted ONLY when: there is no confirmed id, the confirmed
 * product is unavailable, it has a HARD conflict, or the user explicitly chooses
 * "Search again". Soft uncertainty (catalog alias, missing year, below-threshold)
 * preserves the link and only asks for review.
 */

export type ConfirmedProductState =
  | "no_confirmed_id" // nothing linked → fuzzy search is fine
  | "retained" // confirmed product still matches → keep + refresh
  | "soft_review" // soft uncertainty only → keep link, show warning, no fuzzy replace
  | "confirmation_invalidated" // HARD conflict → keep history, mark invalid, offer fuzzy
  | "unavailable"; // product no longer exists → keep history, mark unavailable, offer fuzzy

/** The subset of a lookup result the state machine needs. */
export interface ConfirmedLookup {
  /** false when the product no longer exists on PriceCharting. */
  found: boolean;
  /** true when the fetched product HARD-conflicts with the slab identity. */
  disqualified: boolean;
  /** true when identity is not safe to auto-confirm (hard or soft). */
  requires_confirmation: boolean;
  conflicts: string[];
}

export interface ConfirmedProductDecision {
  state: ConfirmedProductState;
  reason: string;
  /** May a fresh FUZZY search run (and potentially replace the link)? */
  allow_fuzzy: boolean;
  /** Should the confirmed link be preserved (never silently unlinked)? */
  preserve_link: boolean;
}

export function evaluateConfirmedProduct(
  confirmedProductId: string | null | undefined,
  lookup: ConfirmedLookup | null,
  userChoseSearchAgain = false,
): ConfirmedProductDecision {
  if (!confirmedProductId) {
    return { state: "no_confirmed_id", reason: "No confirmed product is linked.", allow_fuzzy: true, preserve_link: false };
  }
  // A confirmed product could not be fetched → it no longer exists.
  if (!lookup || !lookup.found) {
    return {
      state: "unavailable",
      reason: "The confirmed PriceCharting product is no longer available. Its id is preserved; fuzzy recovery is offered.",
      allow_fuzzy: true,
      preserve_link: true,
    };
  }
  // Hard identity conflict → invalidate the confirmation but keep its history.
  if (lookup.disqualified) {
    return {
      state: "confirmation_invalidated",
      reason: `The confirmed product now HARD-conflicts with the slab identity (${lookup.conflicts.join("; ")}). Confirmation history preserved; a new search is offered.`,
      allow_fuzzy: true,
      preserve_link: true,
    };
  }
  // Soft uncertainty only → keep the link, warn, do NOT fuzzy-replace.
  if (lookup.requires_confirmation) {
    return {
      state: "soft_review",
      reason: `Soft uncertainty (${lookup.conflicts.join("; ") || "below auto-confirm threshold"}). The confirmed link is preserved; review is recommended but not required.`,
      allow_fuzzy: userChoseSearchAgain,
      preserve_link: true,
    };
  }
  // Compatible → retain and refresh. Fuzzy only if the user explicitly asks.
  return {
    state: "retained",
    reason: "The confirmed product still matches the slab identity — retained and refreshed.",
    allow_fuzzy: userChoseSearchAgain,
    preserve_link: true,
  };
}
