import { describe, it, expect } from "vitest";
import {
  buildImageManifest, buildIntendedState, canonicalAspects, canonicalDescriptors,
  canonicalListingFingerprint, IMAGE_MANIFEST_VERSION, INTENDED_STATE_VERSION,
  LISTING_FINGERPRINT_VERSION, normalizePriceString, parseImageManifest, parseIntendedState,
  type IntendedStateInput,
} from "../../../supabase/functions/_shared/ebay-intended-state";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const baseInput: IntendedStateInput = {
  sku: "GCV000047", marketplaceId: "EBAY_US", categoryId: "183454", merchantLocationKey: "LOC-A",
  fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1", price: 199.99, currency: "USD",
  availableQuantity: 1, listingDescription: "Graded card.", title: "2016 Charizard PSA 10", description: "Graded.",
  condition: "LIKE_NEW", conditionDescription: "Gem", conditionDescriptors: [], aspects: { Grade: ["10"], Grader: ["PSA"] },
};
const manifest = () => buildImageManifest([{ role: "front", path: "slabs/47/front.jpg", sha256: H1 }, { role: "back", path: "slabs/47/back.jpg", sha256: H2 }])!;

describe("normalizePriceString", () => {
  it("normalizes to 2dp; rejects non-positive/non-finite", () => {
    expect(normalizePriceString(199.9)).toBe("199.90");
    expect(normalizePriceString("10")).toBe("10.00");
    expect(normalizePriceString(0)).toBeNull();
    expect(normalizePriceString(-5)).toBeNull();
    expect(normalizePriceString("x")).toBeNull();
  });
});

describe("canonicalAspects / canonicalDescriptors", () => {
  it("sorts aspect values, drops non-strings/empties, keeps string keys", () => {
    expect(canonicalAspects({ A: ["z", "a"], B: "x", Bad: [1, 2], "": ["y"] })).toEqual({ A: ["a", "z"], B: ["x"] });
  });
  it("normalizes descriptors to sorted name=values and sorts the list", () => {
    expect(canonicalDescriptors([{ name: "Corners", values: ["b", "a"] }, "Edges"])).toEqual(["Corners=a,b", "Edges"]);
  });
});

describe("buildIntendedState", () => {
  it("builds a canonical v1 snapshot with 2dp price + sorted aspects", () => {
    const s = buildIntendedState(baseInput)!;
    expect(s.version).toBe(INTENDED_STATE_VERSION);
    expect(s.price).toBe("199.99");
    expect(s.format).toBe("FIXED_PRICE");
    expect(s.aspects).toEqual({ Grade: ["10"], Grader: ["PSA"] });
  });
  it("returns null for a non-positive price / non-int quantity / missing required field", () => {
    expect(buildIntendedState({ ...baseInput, price: 0 })).toBeNull();
    expect(buildIntendedState({ ...baseInput, availableQuantity: 1.5 })).toBeNull();
    expect(buildIntendedState({ ...baseInput, title: "" })).toBeNull();
    expect(buildIntendedState({ ...baseInput, merchantLocationKey: "" })).toBeNull();
  });
});

describe("buildImageManifest", () => {
  it("builds an ordered v1 manifest with count", () => {
    const m = manifest();
    expect(m.version).toBe(IMAGE_MANIFEST_VERSION);
    expect(m.count).toBe(2);
    expect(m.images[0].role).toBe("front");
  });
  it("rejects a missing front, empty list, bad hash, or bad role", () => {
    expect(buildImageManifest([])).toBeNull();
    expect(buildImageManifest([{ role: "back", path: "b.jpg", sha256: H1 }])).toBeNull();
    expect(buildImageManifest([{ role: "front", path: "f.jpg", sha256: "short" }])).toBeNull();
    // deno-lint-ignore no-explicit-any
    expect(buildImageManifest([{ role: "side" as any, path: "f.jpg", sha256: H1 }])).toBeNull();
  });
});

describe("parseIntendedState — strict versioned parser", () => {
  const stored = () => JSON.parse(JSON.stringify(buildIntendedState(baseInput)));
  it("round-trips a valid snapshot", () => {
    expect(parseIntendedState(stored())).toEqual(buildIntendedState(baseInput));
  });
  it("fails closed (null) on wrong version, bad format, non-canonical price, bad quantity, bad aspects", () => {
    expect(parseIntendedState({ ...stored(), version: 2 })).toBeNull();
    expect(parseIntendedState({ ...stored(), format: "AUCTION" })).toBeNull();
    expect(parseIntendedState({ ...stored(), price: "199.9" })).toBeNull(); // not 2dp canonical
    expect(parseIntendedState({ ...stored(), availableQuantity: -1 })).toBeNull();
    expect(parseIntendedState({ ...stored(), aspects: { Grade: "10" } })).toBeNull(); // value not array
    expect(parseIntendedState({ ...stored(), title: "" })).toBeNull();
    expect(parseIntendedState(null)).toBeNull();
    expect(parseIntendedState("nope")).toBeNull();
  });
});

describe("parseImageManifest — strict versioned parser", () => {
  const stored = () => JSON.parse(JSON.stringify(manifest()));
  it("round-trips a valid manifest", () => {
    expect(parseImageManifest(stored())).toEqual(manifest());
  });
  it("fails closed on wrong version, bad count, bad hash, missing front", () => {
    expect(parseImageManifest({ ...stored(), version: 9 })).toBeNull();
    expect(parseImageManifest({ ...stored(), count: 5 })).toBeNull();
    const badHash = stored(); badHash.images[0].sha256 = "zz"; expect(parseImageManifest(badHash)).toBeNull();
    const noFront = stored(); noFront.images[0].role = "back"; expect(parseImageManifest(noFront)).toBeNull();
  });
});

describe("canonicalListingFingerprint — SHA-256, order-stable, signed-URL-free", () => {
  it("is a 64-char hex digest tagged by the fingerprint version", async () => {
    const fp = await canonicalListingFingerprint(buildIntendedState(baseInput)!, manifest());
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(LISTING_FINGERPRINT_VERSION).toBe(3);
  });
  it("is independent of aspect-KEY order and aspect-VALUE order", async () => {
    const a = await canonicalListingFingerprint(buildIntendedState({ ...baseInput, aspects: { Grade: ["10"], Grader: ["PSA"] } })!, manifest());
    const b = await canonicalListingFingerprint(buildIntendedState({ ...baseInput, aspects: { Grader: ["PSA"], Grade: ["10"] } })!, manifest());
    expect(a).toBe(b);
    const multiA = await canonicalListingFingerprint(buildIntendedState({ ...baseInput, aspects: { Feature: ["Holo", "First Edition"] } })!, manifest());
    const multiB = await canonicalListingFingerprint(buildIntendedState({ ...baseInput, aspects: { Feature: ["First Edition", "Holo"] } })!, manifest());
    expect(multiA).toBe(multiB);
  });
  it("is independent of condition-descriptor order", async () => {
    const a = await canonicalListingFingerprint(buildIntendedState({ ...baseInput, conditionDescriptors: [{ name: "Corners", values: ["A"] }, { name: "Edges", values: ["B"] }] })!, manifest());
    const b = await canonicalListingFingerprint(buildIntendedState({ ...baseInput, conditionDescriptors: [{ name: "Edges", values: ["B"] }, { name: "Corners", values: ["A"] }] })!, manifest());
    expect(a).toBe(b);
  });
  it("CHANGES when price, quantity, condition, title, description, policy, SKU, marketplace or an image hash changes", async () => {
    const base = await canonicalListingFingerprint(buildIntendedState(baseInput)!, manifest());
    const diff = async (over: Partial<IntendedStateInput>) => canonicalListingFingerprint(buildIntendedState({ ...baseInput, ...over })!, manifest());
    for (const over of [{ price: 200 }, { availableQuantity: 2 }, { condition: "USED" }, { title: "Other" }, { description: "Other" }, { fulfillmentPolicyId: "F9" }, { sku: "GCV000048" }, { marketplaceId: "EBAY_GB" }] as Partial<IntendedStateInput>[]) {
      expect(await diff(over)).not.toBe(base);
    }
    // A changed image byte hash changes the fingerprint (images are IN the hash).
    const otherImages = buildImageManifest([{ role: "front", path: "slabs/47/front.jpg", sha256: "c".repeat(64) }, { role: "back", path: "slabs/47/back.jpg", sha256: H2 }])!;
    expect(await canonicalListingFingerprint(buildIntendedState(baseInput)!, otherImages)).not.toBe(base);
  });
  it("does NOT depend on signed URLs (they never enter the state or manifest)", async () => {
    // Two fingerprints built from the same state + same manifest (paths+hashes) are
    // identical regardless of any signed URL generated elsewhere.
    const a = await canonicalListingFingerprint(buildIntendedState(baseInput)!, manifest());
    const b = await canonicalListingFingerprint(buildIntendedState(baseInput)!, manifest());
    expect(a).toBe(b);
  });
});
