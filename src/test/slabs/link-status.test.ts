import { describe, it, expect } from "vitest";
import {
  deriveCandidateStatus,
  shouldShowBelowThresholdBanner,
  type LinkCandidateLike,
  type CandidateStatusContext,
} from "@/lib/slabs/link-status";

const candidate = (over: Partial<LinkCandidateLike> = {}): LinkCandidateLike => ({
  product_id: "P1",
  confidence_score: 90,
  match_status: "likely",
  conflicts: [],
  rejected: false,
  ...over,
});

const ctx = (over: Partial<CandidateStatusContext> = {}): CandidateStatusContext => ({
  selectedProductId: null,
  autoConfirmedProductId: null,
  requiresConfirmation: true,
  ...over,
});

describe("deriveCandidateStatus — exactly one status, no contradictions", () => {
  it("a user-linked candidate is 'User-confirmed' — NOT 'likely' and NOT 'below threshold'", () => {
    // The exact forbidden combination: gate open (requiresConfirmation), raw tag
    // 'likely', and the operator has linked this very product.
    const v = deriveCandidateStatus(
      candidate({ match_status: "likely" }),
      ctx({ selectedProductId: "P1", requiresConfirmation: true }),
    );
    expect(v.status).toBe("user_confirmed");
    expect(v.label).toBe("User-confirmed");
    expect(v.tone).toBe("confirmed");
  });

  it("the auto-confirmed recommended product (gate cleared) is 'Confirmed'", () => {
    const v = deriveCandidateStatus(
      candidate({ product_id: "P1" }),
      ctx({ requiresConfirmation: false, autoConfirmedProductId: "P1" }),
    );
    expect(v.status).toBe("confirmed");
  });

  it("a gate-cleared but non-recommended eligible candidate is 'Alternative'", () => {
    const v = deriveCandidateStatus(
      candidate({ product_id: "P2" }),
      ctx({ requiresConfirmation: false, autoConfirmedProductId: "P1" }),
    );
    expect(v.status).toBe("alternative");
  });

  it("a rejected candidate is 'Rejected' regardless of score", () => {
    const v = deriveCandidateStatus(candidate({ rejected: true, confidence_score: 99 }), ctx());
    expect(v.status).toBe("rejected");
    expect(v.tone).toBe("rejected");
  });

  it("a card-number-only promotion (unverified + conflicts) needs visual confirmation", () => {
    const v = deriveCandidateStatus(
      candidate({ match_status: "unverified", conflicts: ["card_number mismatch"] }),
      ctx(),
    );
    expect(v.status).toBe("needs_visual_confirmation");
  });

  it("below-gate proposals split by the 85 high-confidence bar", () => {
    expect(deriveCandidateStatus(candidate({ confidence_score: 88 }), ctx()).status).toBe(
      "high_confidence_proposed",
    );
    expect(deriveCandidateStatus(candidate({ confidence_score: 72 }), ctx()).status).toBe(
      "needs_confirmation",
    );
  });

  it("user confirmation OUTRANKS a rejection flag (operator override is authoritative)", () => {
    const v = deriveCandidateStatus(
      candidate({ rejected: true }),
      ctx({ selectedProductId: "P1" }),
    );
    expect(v.status).toBe("user_confirmed");
  });
});

describe("shouldShowBelowThresholdBanner", () => {
  it("shows only when the gate is open, nothing is selected, and candidates exist", () => {
    expect(
      shouldShowBelowThresholdBanner({ requiresConfirmation: true, selectedProductId: null, candidateCount: 3 }),
    ).toBe(true);
  });

  it("disappears the moment a product is confirmed (kills the contradiction at the page level)", () => {
    expect(
      shouldShowBelowThresholdBanner({ requiresConfirmation: true, selectedProductId: "P1", candidateCount: 3 }),
    ).toBe(false);
  });

  it("never shows when the gate has cleared or there are no candidates", () => {
    expect(
      shouldShowBelowThresholdBanner({ requiresConfirmation: false, selectedProductId: null, candidateCount: 3 }),
    ).toBe(false);
    expect(
      shouldShowBelowThresholdBanner({ requiresConfirmation: true, selectedProductId: null, candidateCount: 0 }),
    ).toBe(false);
  });
});
