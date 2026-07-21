import { describe, it, expect } from "vitest";
import { ebayListingTitle, slabImagePaths, requiredAspectNames, conditionPolicyValues, evaluatePublishReadiness, type ListingSlab, type PublishReadinessInput } from "../../lib/slabs/ebay-listing";

describe("ebayListingTitle", () => {
  const full: ListingSlab = {
    year: 2016, set_name: "XY Evolutions", card_name: "Charizard", card_number: "11",
    variation: "Holo", rarity: "Rare Holo", grader: "PSA", grade_label: "GEM MT", grade: "10",
  };

  it("assembles a rich title in display order and stays within 80 chars", () => {
    const t = ebayListingTitle(full);
    expect(t.length).toBeLessThanOrEqual(80);
    expect(t).toBe("2016 XY Evolutions Charizard #11 Holo Rare Holo PSA GEM MT 10");
  });

  it("always keeps the card name and the grade suffix", () => {
    const t = ebayListingTitle(full);
    expect(t).toContain("Charizard");
    expect(t).toContain("PSA GEM MT 10");
  });

  it("drops low-value tokens (rarity → variation → #num → year → set) to fit the cap", () => {
    const longSet: ListingSlab = {
      ...full,
      set_name: "Super Long Championship Promotional Set Name Edition Deluxe",
      card_name: "Charizard VMAX Rainbow Rare Secret",
    };
    const t = ebayListingTitle(longSet);
    expect(t.length).toBeLessThanOrEqual(80);
    expect(t).toContain("Charizard VMAX Rainbow Rare Secret"); // name kept
    expect(t).toContain("PSA GEM MT 10"); // grade kept
    expect(t).not.toContain("Rare Holo"); // rarity dropped first
  });

  it("hard-truncates as a final guard when even name + grade exceed the cap", () => {
    const t = ebayListingTitle({ card_name: "X".repeat(120), grader: "PSA", grade: "10" }, 80);
    expect(t.length).toBe(80);
  });

  it("degrades gracefully with almost no data", () => {
    expect(ebayListingTitle({ grader: "PSA", grade: "10" })).toBe("Graded Card PSA 10");
    expect(ebayListingTitle({})).toBe("Graded Card");
  });
});

describe("slabImagePaths", () => {
  it("returns front then back, dropping empty/missing paths", () => {
    expect(slabImagePaths({ front_image_path: "f.jpg", back_image_path: "b.jpg" })).toEqual(["f.jpg", "b.jpg"]);
    expect(slabImagePaths({ front_image_path: "f.jpg", back_image_path: null })).toEqual(["f.jpg"]);
    expect(slabImagePaths({ front_image_path: "  ", back_image_path: "b.jpg" })).toEqual(["b.jpg"]);
    expect(slabImagePaths({})).toEqual([]);
  });
});

describe("requiredAspectNames", () => {
  it("returns only the aspects eBay marks required", () => {
    const aspects = { aspects: [
      { localizedAspectName: "Grade", aspectConstraint: { aspectRequired: true } },
      { localizedAspectName: "Card Name", aspectConstraint: { aspectRequired: true } },
      { localizedAspectName: "Autographed", aspectConstraint: { aspectRequired: false } },
    ] };
    expect(requiredAspectNames(aspects)).toEqual(["Grade", "Card Name"]);
  });
  it("is safe on missing/garbage input", () => {
    expect(requiredAspectNames(null)).toEqual([]);
    expect(requiredAspectNames({})).toEqual([]);
    expect(requiredAspectNames({ aspects: "nope" })).toEqual([]);
  });
});

describe("conditionPolicyValues", () => {
  it("lists allowed condition descriptions", () => {
    const cp = { itemConditionPolicies: [{ itemConditions: [{ conditionId: "2750", conditionDescription: "Graded" }, { conditionId: "4000" }] }] };
    expect(conditionPolicyValues(cp)).toEqual(["Graded", "4000"]);
  });
  it("is safe on missing input", () => {
    expect(conditionPolicyValues(null)).toEqual([]);
  });
});

describe("evaluatePublishReadiness", () => {
  const ready: PublishReadinessInput = {
    connected: true, preparedOk: true, preparedFailedResource: null,
    sku: "GCV000047", title: "2016 XY Evolutions Charizard #11 PSA 10", description: "Graded card.",
    price: 199.99, currency: "USD", categoryId: "183454", condition: "GRADED",
    locationKey: "LOC-A", fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1",
    locationKeys: ["LOC-A"], fulfillmentPolicyIds: ["F1"], paymentPolicyIds: ["P1"], returnPolicyIds: ["R1"],
    imageCount: 2, requiredAspects: [], providedAspects: {},
  };

  it("allows publish when every requirement is satisfied", () => {
    const r = evaluatePublishReadiness(ready);
    expect(r.canPublish).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  it("a failed/absent preparation never enables publish", () => {
    expect(evaluatePublishReadiness({ ...ready, preparedOk: false, preparedFailedResource: null }).canPublish).toBe(false);
    expect(evaluatePublishReadiness({ ...ready, preparedOk: false, preparedFailedResource: "config_error" }).blockers.join()).toContain("config_error");
  });

  it("blocks on invalid title, price, currency, and missing description", () => {
    expect(evaluatePublishReadiness({ ...ready, title: "" }).canPublish).toBe(false);
    expect(evaluatePublishReadiness({ ...ready, title: "X".repeat(81) }).canPublish).toBe(false);
    expect(evaluatePublishReadiness({ ...ready, price: 0 }).canPublish).toBe(false);
    expect(evaluatePublishReadiness({ ...ready, price: Number.NaN }).canPublish).toBe(false);
    expect(evaluatePublishReadiness({ ...ready, currency: "EUR" }).canPublish).toBe(false);
    expect(evaluatePublishReadiness({ ...ready, description: "  " }).canPublish).toBe(false);
  });

  it("requires location + policies chosen FROM discovery options", () => {
    expect(evaluatePublishReadiness({ ...ready, locationKey: "NOT-IN-LIST" }).canPublish).toBe(false);
    expect(evaluatePublishReadiness({ ...ready, fulfillmentPolicyId: "" }).canPublish).toBe(false);
    expect(evaluatePublishReadiness({ ...ready, paymentPolicyIds: [] }).canPublish).toBe(false);
  });

  it("blocks when there is no front image", () => {
    expect(evaluatePublishReadiness({ ...ready, imageCount: 0 }).canPublish).toBe(false);
  });

  it("blocks when a required category aspect is not provided, and lists it", () => {
    const r = evaluatePublishReadiness({ ...ready, requiredAspects: ["Grade", "Card Name"], providedAspects: { Grade: "10" } });
    expect(r.canPublish).toBe(false);
    expect(r.blockers.join()).toContain("Card Name");
    expect(r.blockers.join()).not.toContain("Grade,"); // Grade was provided
  });
});
