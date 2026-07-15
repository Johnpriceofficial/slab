import { describe, it, expect } from "vitest";
import { assessIdentityCompleteness } from "@/lib/identity/completeness";

describe("assessIdentityCompleteness", () => {
  it("downgrades a raw card missing helpful fields to partial WITHOUT blocking", () => {
    // Has name + number, but no language/variation/finish (the raw-card reality
    // today: those columns aren't persisted yet).
    const c = assessIdentityCompleteness({ card_name: "Charizard", card_number: "4/102" }, "raw");
    expect(c.status).toBe("partial");
    expect(c.missing).toEqual(expect.arrayContaining(["language", "variation", "finish"]));
    // Every missing field is explained.
    expect(c.notes.length).toBeGreaterThan(0);
    // Partial is NOT a block — card_number is present so exact matching is possible.
    expect(c.missing).not.toContain("card_number");
  });

  it("marks a raw card with NO card number as ambiguous (blocks exact matching)", () => {
    const c = assessIdentityCompleteness({ card_name: "Charizard" }, "raw");
    expect(c.status).toBe("ambiguous");
    expect(c.missing).toContain("card_number");
  });

  it("does NOT count a missing certification number against a raw card's valuation", () => {
    // Fully identified raw card, no cert number — cert is irrelevant to raw valuation.
    const c = assessIdentityCompleteness(
      { card_name: "Charizard", card_number: "4/102", language: "English", variation: "1st Edition", finish: "Holo" },
      "raw",
    );
    expect(c.status).toBe("complete");
    expect(c.missing).not.toContain("certification_number");
    // It is still noted as irrelevant, not silently dropped.
    expect(c.notes.some((n) => n.field === "certification_number" && n.effect === "irrelevant")).toBe(true);
  });

  it("treats a certified card's missing cert as verification-only, not a valuation block", () => {
    const c = assessIdentityCompleteness(
      { card_name: "Charizard", card_number: "4/102", language: "English", variation: "1st Edition", finish: "Holo", grader: "PSA", grade: "10" },
      "certified",
    );
    expect(c.status).toBe("complete"); // cert absence does not make valuation ambiguous
    const certNote = c.notes.find((n) => n.field === "certification_number");
    expect(certNote?.detail).toMatch(/specimen verification/i);
  });
});
