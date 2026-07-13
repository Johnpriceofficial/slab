import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CandidateDebugPanel } from "@/components/slabs/CandidateDebugPanel";
import type { ScoreBreakdown } from "@/lib/pricecharting/matching";

const breakdown: ScoreBreakdown = {
  raw_score: 76,
  adjusted_score: 95,
  identity_floor_applied: true,
  identity_floor_reason: "Exact character + exact distinctive collector number, no conflicts.",
  eligible: true,
  disqualified: false,
  hard_conflicts: [],
  soft_conflicts: ["Year mismatch: wanted 1998, candidate 2021"],
  warnings: ["set not found"],
  score_contributions: [{ field: "character", points: 30 }],
  score_deductions: [{ field: "set", points: 20, reason: "catalog alias" }],
  fields: [
    { field: "character", requested_value: "Charmander", candidate_value: "Charmander #289/S-P", normalized_requested_value: "charmander", normalized_candidate_value: "charmander", result: "exact", hard_conflict: false, points_possible: 30, points_awarded: 30, explanation: "ok" },
    { field: "complete_card_number", requested_value: "289/S-P", candidate_value: "289/S-P", normalized_requested_value: "289/s-p", normalized_candidate_value: "289/s-p", result: "normalized_exact", hard_conflict: false, points_possible: 30, points_awarded: 30, explanation: "ok" },
    { field: "artwork", requested_value: null, candidate_value: null, normalized_requested_value: null, normalized_candidate_value: null, result: "not_checked", hard_conflict: false, points_possible: 0, points_awarded: 0, explanation: "no artwork" },
  ],
};

describe("§2 CandidateDebugPanel", () => {
  it("renders raw + adjusted scores, the floor reason, soft conflicts and the field table", () => {
    render(<CandidateDebugPanel breakdown={breakdown} />);
    expect(screen.getByText("Why this match?")).toBeTruthy();
    expect(screen.getByText(/Raw score:/)).toBeTruthy();
    expect(screen.getByText("95")).toBeTruthy();
    expect(screen.getByText(/Identity floor/)).toBeTruthy();
    expect(screen.getByText(/Year mismatch/)).toBeTruthy();
    expect(screen.getByText("character")).toBeTruthy();
    expect(screen.getByText("complete_card_number")).toBeTruthy();
    expect(screen.getByText("artwork")).toBeTruthy();
    expect(screen.getByText("not checked")).toBeTruthy();
  });

  it("is collapsed by default (details has no open attribute)", () => {
    render(<CandidateDebugPanel breakdown={breakdown} />);
    const details = screen.getByText("Why this match?").closest("details");
    expect(details).toBeTruthy();
    expect(details?.hasAttribute("open")).toBe(false);
  });
});
