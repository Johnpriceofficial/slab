import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearNewSlabDraft,
  loadNewSlabDraft,
  saveNewSlabDraft,
  type NewSlabDraftSnapshot,
} from "@/lib/slabs/new-slab-draft";

function image(name: string, contents: string) {
  const originalFile = new File([`original-${contents}`], name, { type: "image/jpeg", lastModified: 10 });
  const file = new File([contents], `normalized-${name}`, { type: "image/jpeg", lastModified: 20 });
  return { originalFile, file, previewUrl: `blob:${name}`, ext: "jpg" };
}

beforeEach(async () => {
  URL.createObjectURL = vi.fn((file: Blob) => `blob:restored-${file.size}`);
  URL.revokeObjectURL = vi.fn();
  await clearNewSlabDraft();
});

describe("new slab audit draft", () => {
  it("round-trips images, identity, analysis, PriceCharting, and valuation state", async () => {
    const draft: NewSlabDraftSnapshot = {
      front: image("front.jpg", "front-bytes"),
      back: image("back.jpg", "back-bytes"),
      id: {
        card_name: "N's Zoroark ex",
        set_name: "Mega Dream ex",
        card_number: "112/193",
        grader: "CGC",
        grade: "10",
        grade_label: "PRISTINE",
        certification_number: "6155520245",
      },
      val: {
        guide: "34.99",
        final: "34.99",
        quick: "27.99",
        replacement: "38.49",
        confidence: "high",
        notes: "Exact CGC 10 Pristine tier",
        date_valued: "2026-07-16",
      },
      pc: {
        product_id: "11302479",
        product_name: "N's Zoroark ex #112",
        grade_field: "cgc-10-pristine-price",
        value_cents: 3499,
        sales_volume: null,
        match_status: "exact",
        confidence_score: 100,
        is_estimate: false,
        available_values_cents: { cgc_10_pristine: 3499 },
        value_response: { guide_value_cents: 3499 },
        canonical_url: "https://www.pricecharting.com/game/pokemon-japanese-mega-dream-ex/n's-zoroark-ex-112",
        tier_availability: "available",
        selected_tier_key: "cgc_10_pristine",
        designation_exact: true,
        selected_tier_label: "CGC 10 Pristine",
        valuation_source: "PRICECHARTING_PUBLIC_PAGE",
        public_page: null,
        reference_artwork: null,
      },
      visual: {
        product_id: "11302479",
        status: "user_confirmed",
        imageUrl: "https://example.test/zoroark.jpg",
        imageSource: "official_product",
      },
      rejected: null,
      analysis: null,
      valProvenance: "pricecharting_exact_tier",
      valStale: false,
      pcStale: false,
    };

    await saveNewSlabDraft(draft);
    const restored = await loadNewSlabDraft();

    expect(restored?.id).toEqual(draft.id);
    expect(restored?.val).toEqual(draft.val);
    expect(restored?.pc?.product_id).toBe("11302479");
    expect(restored?.visual).toEqual(draft.visual);
    expect(restored?.valProvenance).toBe("pricecharting_exact_tier");
    expect(restored?.front?.originalFile.name).toBe("front.jpg");
    expect(restored?.front?.file.name).toBe("normalized-front.jpg");
    expect(restored?.front?.file.size).toBe(draft.front?.file.size);
    expect(restored?.back?.originalFile.name).toBe("back.jpg");
    expect(restored?.front?.previewUrl).toMatch(/^blob:restored-/);
  });

  it("clears the audit after an intentional completion", async () => {
    await saveNewSlabDraft({
      front: image("front.jpg", "bytes"),
      back: null,
      id: {},
      val: {},
      pc: null,
      visual: null,
      rejected: null,
      analysis: null,
      valProvenance: "tier_unavailable",
      valStale: false,
      pcStale: false,
    });

    await clearNewSlabDraft();
    expect(await loadNewSlabDraft()).toBeNull();
  });
});
