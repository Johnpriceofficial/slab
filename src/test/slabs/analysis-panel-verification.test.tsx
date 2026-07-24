/**
 * SlabAnalysisPanel — the verification UI contract.
 *
 * Low-confidence readings stay usable (Requirement 6), and an unreadable
 * certification shows the exact actionable message rather than a bare flag.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SlabAnalysisPanel } from "@/components/slabs/SlabAnalysisPanel";
import { ANALYZE_FIELD_KEYS, type AnalyzeProposal, type AnalyzeResult } from "@/server/analyze-slab/handler";

function proposal(overrides: Partial<Record<keyof AnalyzeProposal, { value: string | null; confidence: number; readable: boolean }>>): AnalyzeProposal {
  const p = {} as AnalyzeProposal;
  for (const k of ANALYZE_FIELD_KEYS) {
    const o = overrides[k];
    p[k] = o
      ? { value: o.value, confidence: o.confidence, source: "label", readable: o.readable }
      : { value: null, confidence: 0, source: "unknown", readable: false };
  }
  return p;
}

function result(overrides: Parameters<typeof proposal>[0], extra: Partial<AnalyzeResult> = {}): AnalyzeResult {
  return {
    status: "success",
    proposed: proposal(overrides),
    overall_confidence: 0.8,
    label_matches_card: true,
    warnings: [],
    requires_confirmation: true,
    ...extra,
  };
}

afterEach(cleanup);

describe("low-confidence fields remain applyable/editable", () => {
  it("still offers Apply for a low-confidence readable field and flags it", () => {
    const onApplyField = vi.fn();
    render(
      <SlabAnalysisPanel
        result={result({ card_name: { value: "Charizard", confidence: 0.42, readable: true } })}
        onApplyField={onApplyField}
        onApplyAll={vi.fn()}
      />,
    );
    // The low-confidence badge is shown (destructive variant) AND Apply works —
    // low confidence surfaces the field for scrutiny, it never blocks using it.
    expect(screen.getByText(/42%/)).toBeInTheDocument();
    const applyButtons = screen.getAllByRole("button", { name: /^apply$/i });
    fireEvent.click(applyButtons[0]);
    expect(onApplyField).toHaveBeenCalledWith("card_name", "Charizard");
  });
});

describe("automation summary", () => {
  it("shows populated fields, review fields, PriceCharting tier, guide value, and certification status", () => {
    render(
      <SlabAnalysisPanel
        result={result({ certification_number: { value: "6165347099", confidence: 0.99, readable: true } })}
        automation={{
          automaticallyPopulated: ["Card Name", "Certification #"],
          requiringReview: ["Finish / Variation"],
          unresolvedCanonicalFields: ["Finish / Variation"],
          certificationStatus: "Certification number visually extracted for CGC. Certification database verification is not configured for this grader.",
          priceChartingProduct: "Venusaur #3 (PriceCharting ID 1003)",
          selectedValuationTier: "CGC 10 Pristine",
          guideValue: "$60.00",
          verificationLevel: "Visually verified",
        }}
        onApplyField={vi.fn()}
        onApplyAll={vi.fn()}
      />,
    );

    expect(screen.getByText("Card Name, Certification #")).toBeInTheDocument();
    expect(screen.getAllByText("Finish / Variation")).toHaveLength(2);
    expect(screen.getByText(/Certification database verification is not configured for this grader/)).toBeInTheDocument();
    expect(screen.getByText("Venusaur #3 (PriceCharting ID 1003)")).toBeInTheDocument();
    expect(screen.getByText("CGC 10 Pristine")).toBeInTheDocument();
    expect(screen.getByText("$60.00")).toBeInTheDocument();
  });
});

describe("unreadable certification messaging", () => {
  it("shows the exact actionable message when the certification is unreadable", () => {
    render(
      <SlabAnalysisPanel
        result={result({
          card_name: { value: "Charizard", confidence: 0.9, readable: true },
          certification_number: { value: null, confidence: 0, readable: false },
        })}
        onApplyField={vi.fn()}
        onApplyAll={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/certification number was not readable with confidence/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/retake a sharper.*front-label image or enter it manually/i)).toBeInTheDocument();
  });

  it("does not show the certification message when it was read", () => {
    render(
      <SlabAnalysisPanel
        result={result({ certification_number: { value: "01234567", confidence: 0.95, readable: true } })}
        onApplyField={vi.fn()}
        onApplyAll={vi.fn()}
      />,
    );
    expect(screen.queryByText(/not readable with confidence/i)).not.toBeInTheDocument();
  });
});
