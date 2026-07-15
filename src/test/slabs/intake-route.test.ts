import { describe, it, expect } from "vitest";
import { decideIntakeRoute, routeLabel, DEFAULT_ROUTE_CONFIDENCE } from "@/lib/slabs/intake-route";
import type { ItemClassification } from "@/lib/slabs/classify-item";

const c = (type: ItemClassification["type"], confidence: number): ItemClassification => ({ type, confidence, signals: [] });

describe("decideIntakeRoute", () => {
  it("routes a confident graded slab to the slab intake", () => {
    expect(decideIntakeRoute(c("graded_slab", 0.95))).toBe("slab");
  });

  it("routes a confident raw card to the raw intake", () => {
    expect(decideIntakeRoute(c("raw_card", 0.9))).toBe("raw");
  });

  it("asks the operator to choose when confidence is below threshold", () => {
    expect(decideIntakeRoute(c("graded_slab", 0.5))).toBe("choose");
    expect(decideIntakeRoute(c("raw_card", 0.6))).toBe("choose");
  });

  it("treats exactly the threshold as confident", () => {
    expect(decideIntakeRoute(c("raw_card", DEFAULT_ROUTE_CONFIDENCE))).toBe("raw");
  });

  it("honors a custom threshold", () => {
    expect(decideIntakeRoute(c("graded_slab", 0.8), 0.9)).toBe("choose");
  });

  it("labels each route for the overlay", () => {
    expect(routeLabel("slab")).toMatch(/graded slab/i);
    expect(routeLabel("raw")).toMatch(/raw card/i);
    expect(routeLabel("choose")).toMatch(/couldn't determine/i);
  });
});
