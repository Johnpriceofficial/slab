/**
 * Single source of truth for the PriceCharting link status shown on each
 * candidate in the intake workflow.
 *
 * THE BUG THIS FIXES: the panel previously showed THREE decoupled signals at
 * once — the raw per-candidate match badge ("likely"), a page-level "confidence
 * is below the auto-confirm threshold" banner, and the per-row "Linked" button.
 * A card the operator had explicitly confirmed could therefore read as
 * "Likely" + "below threshold" + "Linked" simultaneously, which is incoherent.
 *
 * Here every candidate resolves to EXACTLY ONE status, and the page-level
 * banner is suppressed once a product is confirmed. The states are strict and
 * mutually exclusive — a confirmed card is never also "below threshold".
 */

export type LinkStatus =
  | "user_confirmed" // the operator explicitly linked this product
  | "confirmed" // auto-confirmed: gate cleared and this is the recommended product
  | "high_confidence_proposed" // eligible, ≥85, but the gate wants explicit confirmation
  | "needs_confirmation" // eligible, proposed, below the high-confidence bar
  | "needs_visual_confirmation" // promoted despite a card-number-only conflict — verify by eye
  | "alternative" // gate cleared for another product; this is a lower-ranked eligible one
  | "rejected" // hard-disqualified on a mandatory identity field
  | "no_product"; // nothing to link

export type LinkTone = "confirmed" | "proposed" | "warning" | "rejected" | "neutral";

export interface LinkStatusView {
  status: LinkStatus;
  label: string;
  tone: LinkTone;
}

/** The minimal candidate shape this derivation needs (subset of CandidateResult). */
export interface LinkCandidateLike {
  product_id: string;
  confidence_score: number;
  /** Server match tag: "exact" | "likely" | "unverified" | "no_match". */
  match_status: string;
  conflicts: string[];
  rejected: boolean;
}

const LABELS: Record<LinkStatus, { label: string; tone: LinkTone }> = {
  user_confirmed: { label: "User-confirmed", tone: "confirmed" },
  confirmed: { label: "Confirmed", tone: "confirmed" },
  high_confidence_proposed: { label: "High-confidence — confirm", tone: "proposed" },
  needs_confirmation: { label: "Proposed — confirm", tone: "proposed" },
  needs_visual_confirmation: { label: "Needs visual confirmation", tone: "warning" },
  alternative: { label: "Alternative", tone: "neutral" },
  rejected: { label: "Rejected", tone: "rejected" },
  no_product: { label: "No product", tone: "neutral" },
};

function view(status: LinkStatus): LinkStatusView {
  const { label, tone } = LABELS[status];
  return { status, label, tone };
}

export interface CandidateStatusContext {
  /** The candidate the operator has explicitly linked (its product_id), if any. */
  selectedProductId: string | null;
  /** The product the server recommends when the confidence gate has cleared. */
  autoConfirmedProductId: string | null;
  /** True when overall confidence is below the auto-confirm threshold. */
  requiresConfirmation: boolean;
}

/**
 * Resolve the single status for one candidate. Priority order guarantees no two
 * signals can co-apply:
 *   1. the operator's own confirmation wins over everything;
 *   2. a hard-disqualified candidate is "Rejected";
 *   3. a card-number-only promotion is "Needs visual confirmation";
 *   4. the server's recommended product (gate cleared) is "Confirmed";
 *   5. otherwise it is a proposal — high-confidence or plain — or, when the gate
 *      has already cleared for a different product, an "Alternative".
 */
export function deriveCandidateStatus(
  candidate: LinkCandidateLike,
  ctx: CandidateStatusContext,
): LinkStatusView {
  if (ctx.selectedProductId && candidate.product_id === ctx.selectedProductId) {
    return view("user_confirmed");
  }
  if (candidate.rejected) return view("rejected");

  // A candidate surfaced only because its sole conflict was the card number
  // (see the handler's number-only-conflict recovery) must be eyeballed.
  if (candidate.match_status === "unverified" && candidate.conflicts.length > 0) {
    return view("needs_visual_confirmation");
  }

  if (!ctx.requiresConfirmation) {
    if (ctx.autoConfirmedProductId && candidate.product_id === ctx.autoConfirmedProductId) {
      return view("confirmed");
    }
    // The gate cleared for another product; this eligible one is a fallback.
    return view("alternative");
  }

  // Gate not cleared → this is a proposal awaiting explicit confirmation.
  return view(candidate.confidence_score >= 85 ? "high_confidence_proposed" : "needs_confirmation");
}

/**
 * Should the page-level "confidence below threshold" banner show?
 * Only when the gate is open AND the operator has not yet confirmed a product.
 * Confirming a product resolves the ambiguity, so the banner must disappear.
 */
export function shouldShowBelowThresholdBanner(args: {
  requiresConfirmation: boolean;
  selectedProductId: string | null;
  candidateCount: number;
}): boolean {
  return args.requiresConfirmation && !args.selectedProductId && args.candidateCount > 0;
}
