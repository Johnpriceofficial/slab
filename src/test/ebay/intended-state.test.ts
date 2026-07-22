import { describe, it, expect } from "vitest";
import {
  buildImageManifest, buildIntendedState, canonicalAspects, canonicalDescriptors,
  canonicalListingFingerprint, isSafeStoragePath, isSha256Hex, LISTING_FINGERPRINT_VERSION,
  normalizePriceString, parseImageManifest, parseIntendedState, timingSafeEqualHex,
  verifyDurableIntendedSnapshot, type IntendedStateInput,
} from "../../../supabase/functions/_shared/ebay-intended-state";

const H1 = "a".repeat(64), H2 = "b".repeat(64), H3 = "c".repeat(64);
const baseInput: IntendedStateInput = {
  sku: "GCV000047", marketplaceId: "EBAY_US", categoryId: "183454", merchantLocationKey: "LOC-A",
  fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1", price: 199.99, currency: "USD",
  availableQuantity: 1, listingDescription: "Graded card.", title: "2016 Charizard PSA 10", description: "Graded.",
  condition: "LIKE_NEW", conditionDescription: "Gem", conditionDescriptors: [], aspects: { Grade: ["10"], Grader: ["PSA"] },
};
const manifest = () => buildImageManifest([{ role: "front", path: "slabs/47/front.jpg", sha256: H1 }, { role: "back", path: "slabs/47/back.jpg", sha256: H2 }])!;

describe("normalizePriceString / canonicalizers", () => {
  it("price → 2dp; rejects non-positive", () => {
    expect(normalizePriceString(199.9)).toBe("199.90");
    expect(normalizePriceString(0)).toBeNull();
    expect(normalizePriceString(-1)).toBeNull();
  });
  it("aspects: sorted values, DEDUPED, string keys only", () => {
    expect(canonicalAspects({ A: ["z", "a", "a"], B: "x", "": ["y"] })).toEqual({ A: ["a", "z"], B: ["x"] });
  });
  it("descriptors: sorted, deduped", () => {
    expect(canonicalDescriptors([{ name: "Corners", values: ["b", "a", "a"] }, "Edges", "Edges"])).toEqual(["Corners=a,b", "Edges"]);
  });
});

describe("isSafeStoragePath / hashes", () => {
  it("accepts a plain in-bucket path, rejects traversal / absolute / scheme / backslash", () => {
    expect(isSafeStoragePath("slabs/47/front.jpg")).toBe(true);
    for (const bad of ["../secret", "/etc/passwd", "a//b", "a\\b", "http://x/y", "data:abc", " lead", "", "a\0b"]) {
      expect(isSafeStoragePath(bad)).toBe(false);
    }
  });
  it("isSha256Hex requires lowercase 64-hex", () => {
    expect(isSha256Hex(H1)).toBe(true);
    expect(isSha256Hex("A".repeat(64))).toBe(false);
    expect(isSha256Hex("a".repeat(63))).toBe(false);
  });
  it("timingSafeEqualHex", () => {
    expect(timingSafeEqualHex(H1, H1)).toBe(true);
    expect(timingSafeEqualHex(H1, H2)).toBe(false);
    expect(timingSafeEqualHex(H1, "a".repeat(63))).toBe(false);
  });
});

describe("buildIntendedState", () => {
  it("builds canonical v1 (2dp price, sorted aspects)", () => {
    const s = buildIntendedState(baseInput)!;
    expect(s).toMatchObject({ version: 1, price: "199.99", format: "FIXED_PRICE", aspects: { Grade: ["10"], Grader: ["PSA"] } });
  });
  it("rejects non-USD currency, quantity out of range, title>80, empty description", () => {
    expect(buildIntendedState({ ...baseInput, currency: "EUR" })).toBeNull();
    expect(buildIntendedState({ ...baseInput, availableQuantity: 0 })).toBeNull();
    expect(buildIntendedState({ ...baseInput, availableQuantity: 1000 })).toBeNull();
    expect(buildIntendedState({ ...baseInput, title: "x".repeat(81) })).toBeNull();
    expect(buildIntendedState({ ...baseInput, description: "" })).toBeNull();
    expect(buildIntendedState({ ...baseInput, listingDescription: "" })).toBeNull();
  });
});

describe("buildImageManifest / parseImageManifest — strict canonical", () => {
  it("builds an ordered manifest", () => {
    expect(manifest()).toMatchObject({ version: 1, count: 2, images: [{ role: "front" }, { role: "back" }] });
  });
  const badBuild: Array<[string, Array<{ role: "front" | "back"; path: string; sha256: string }>]> = [
    ["three images", [{ role: "front", path: "f.jpg", sha256: H1 }, { role: "back", path: "b.jpg", sha256: H2 }, { role: "back", path: "c.jpg", sha256: H3 }]],
    ["back before front", [{ role: "back", path: "b.jpg", sha256: H1 }, { role: "front", path: "f.jpg", sha256: H2 }]],
    ["duplicate front", [{ role: "front", path: "f.jpg", sha256: H1 }, { role: "front", path: "g.jpg", sha256: H2 }]],
    ["duplicate path", [{ role: "front", path: "f.jpg", sha256: H1 }, { role: "back", path: "f.jpg", sha256: H2 }]],
    ["duplicate hash", [{ role: "front", path: "f.jpg", sha256: H1 }, { role: "back", path: "b.jpg", sha256: H1 }]],
    ["traversal path", [{ role: "front", path: "../x.jpg", sha256: H1 }]],
    ["uppercase hash", [{ role: "front", path: "f.jpg", sha256: "A".repeat(64) }]],
    ["empty path", [{ role: "front", path: "", sha256: H1 }]],
  ];
  for (const [name, imgs] of badBuild) it(`rejects: ${name}`, () => expect(buildImageManifest(imgs)).toBeNull());

  it("parser is exact-schema and proves canonical order (never reorders)", () => {
    const good = JSON.parse(JSON.stringify(manifest()));
    expect(parseImageManifest(good)).toEqual(manifest());
    expect(parseImageManifest({ ...good, extra: 1 })).toBeNull();              // unknown top-level field
    const badImg = JSON.parse(JSON.stringify(manifest())); badImg.images[0].extra = 1;
    expect(parseImageManifest(badImg)).toBeNull();                             // unknown image field
    const swapped = JSON.parse(JSON.stringify(manifest())); [swapped.images[0], swapped.images[1]] = [swapped.images[1], swapped.images[0]];
    expect(parseImageManifest(swapped)).toBeNull();                           // back-first: rejected, not reordered
    const badCount = JSON.parse(JSON.stringify(manifest())); badCount.count = 5;
    expect(parseImageManifest(badCount)).toBeNull();
  });
});

describe("parseIntendedState — exact-schema canonical", () => {
  const stored = () => JSON.parse(JSON.stringify(buildIntendedState(baseInput)));
  it("round-trips", () => expect(parseIntendedState(stored())).toEqual(buildIntendedState(baseInput)));
  it("fails closed on unknown field, noncanonical descriptor/aspect order, dup value, bad currency/quantity/title/price", () => {
    expect(parseIntendedState({ ...stored(), extra: 1 })).toBeNull();
    expect(parseIntendedState({ ...stored(), conditionDescriptors: ["b", "a"] })).toBeNull();     // not sorted
    expect(parseIntendedState({ ...stored(), conditionDescriptors: ["a", "a"] })).toBeNull();     // dup
    expect(parseIntendedState({ ...stored(), aspects: { Grade: ["10", "10"] } })).toBeNull();      // dup value
    expect(parseIntendedState({ ...stored(), aspects: { Grade: ["b", "a"] } })).toBeNull();        // unsorted values
    expect(parseIntendedState({ ...stored(), currency: "EUR" })).toBeNull();
    expect(parseIntendedState({ ...stored(), availableQuantity: 0 })).toBeNull();
    expect(parseIntendedState({ ...stored(), title: "x".repeat(81) })).toBeNull();
    expect(parseIntendedState({ ...stored(), price: "199.9" })).toBeNull();
    expect(parseIntendedState({ ...stored(), format: "AUCTION" })).toBeNull();
    expect(parseIntendedState({ ...stored(), description: "" })).toBeNull();
  });
});

// ── §8 fingerprint + snapshot-verify matrix ──────────────────────────────────
const storedRow = (over: { intended?: unknown; manifest?: unknown; fingerprint?: unknown; version?: unknown } = {}) => ({
  intendedState: over.intended ?? JSON.parse(JSON.stringify(buildIntendedState(baseInput))),
  imageManifest: over.manifest ?? JSON.parse(JSON.stringify(manifest())),
  fingerprint: over.fingerprint,
  fingerprintVersion: over.version ?? LISTING_FINGERPRINT_VERSION,
});

describe("canonicalListingFingerprint + verifyDurableIntendedSnapshot", () => {
  it("SHA-256 hex, version 3, key/value-order independent", async () => {
    const fp = await canonicalListingFingerprint(buildIntendedState(baseInput)!, manifest());
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(LISTING_FINGERPRINT_VERSION).toBe(3);
    const reordered = await canonicalListingFingerprint(buildIntendedState({ ...baseInput, aspects: { Grader: ["PSA"], Grade: ["10"] } })!, manifest());
    expect(reordered).toBe(fp);
  });

  it("a VALID stored snapshot verifies (recomputed == stored)", async () => {
    const fp = await canonicalListingFingerprint(buildIntendedState(baseInput)!, manifest());
    const r = await verifyDurableIntendedSnapshot(storedRow({ fingerprint: fp }));
    expect(r.outcome).toBe("valid");
  });

  it("missing / bad-format / unsupported-version fingerprints fail closed", async () => {
    expect((await verifyDurableIntendedSnapshot({ intendedState: null, imageManifest: null, fingerprint: H1, fingerprintVersion: LISTING_FINGERPRINT_VERSION })).outcome).toBe("missing_intended_state");
    expect((await verifyDurableIntendedSnapshot(storedRow({ fingerprint: "not-a-hash" }))).outcome).toBe("invalid_fingerprint_format");
    expect((await verifyDurableIntendedSnapshot(storedRow({ fingerprint: "A".repeat(64) }))).outcome).toBe("invalid_fingerprint_format");
    const fp = await canonicalListingFingerprint(buildIntendedState(baseInput)!, manifest());
    expect((await verifyDurableIntendedSnapshot(storedRow({ fingerprint: fp, version: 2 }))).outcome).toBe("unsupported_fingerprint_version");
    expect((await verifyDurableIntendedSnapshot(storedRow({ intended: { version: 99 }, fingerprint: fp }))).outcome).toBe("invalid_intended_state");
  });

  it("a forged fingerprint paired with valid JSON → fingerprint_mismatch", async () => {
    expect((await verifyDurableIntendedSnapshot(storedRow({ fingerprint: H1 }))).outcome).toBe("fingerprint_mismatch");
  });

  it("ANY altered listing/image field (fingerprint kept) → fingerprint_mismatch", async () => {
    const good = buildIntendedState(baseInput)!;
    const fp = await canonicalListingFingerprint(good, manifest());
    const mutations: Array<() => unknown> = [
      () => ({ ...JSON.parse(JSON.stringify(good)), title: "Other" }),
      () => ({ ...JSON.parse(JSON.stringify(good)), listingDescription: "Other." }),
      () => ({ ...JSON.parse(JSON.stringify(good)), description: "Other." }),
      () => ({ ...JSON.parse(JSON.stringify(good)), condition: "USED" }),
      () => ({ ...JSON.parse(JSON.stringify(good)), conditionDescription: "Near mint" }),
      () => ({ ...JSON.parse(JSON.stringify(good)), conditionDescriptors: ["Corners=A"] }),
      () => ({ ...JSON.parse(JSON.stringify(good)), aspects: { Grade: ["9"], Grader: ["PSA"] } }),
      () => ({ ...JSON.parse(JSON.stringify(good)), fulfillmentPolicyId: "F9" }),
      () => ({ ...JSON.parse(JSON.stringify(good)), price: "200.00" }),
      () => ({ ...JSON.parse(JSON.stringify(good)), availableQuantity: 2 }),
    ];
    for (const m of mutations) {
      expect((await verifyDurableIntendedSnapshot(storedRow({ intended: m(), fingerprint: fp }))).outcome).toBe("fingerprint_mismatch");
    }
    // image hash / path / role / count changes
    const swapHash = JSON.parse(JSON.stringify(manifest())); swapHash.images[0].sha256 = H3;
    const swapPath = JSON.parse(JSON.stringify(manifest())); swapPath.images[0].path = "slabs/47/front-v2.jpg";
    const dropBack = { version: 1, count: 1, images: [JSON.parse(JSON.stringify(manifest())).images[0]] };
    for (const man of [swapHash, swapPath, dropBack]) {
      expect((await verifyDurableIntendedSnapshot(storedRow({ manifest: man, fingerprint: fp }))).outcome).toBe("fingerprint_mismatch");
    }
  });
});
