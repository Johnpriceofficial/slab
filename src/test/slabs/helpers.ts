/**
 * Test helpers for the slab suite: an in-memory SlabDataAccess that emulates the
 * atomic create_slab RPC (race-safe sequential numbering + duplicate guard) plus
 * controllable upload/insert failures. Not a test file (no .test suffix).
 */

import type { SlabDataAccess, SlabDataError } from "@/lib/slabs/save-slab";
import type { Slab, SlabInput } from "@/lib/slabs/types";
import type { SlabPricingWrite } from "@/lib/slabs/pricing-tiers";
import { certCompositeKey } from "@/lib/slabs/normalize";

export interface MockDaoOptions {
  failUpload?: "front" | "back" | null;
  createError?: SlabDataError;
  /** Seed existing (grader, cert) → inventory number, keyed by composite `GRADER:CERT`. */
  existingCerts?: Record<string, number>;
  /** When true, applySlabPricing throws — verifies tier persistence is non-fatal. */
  failPricing?: boolean;
  stalePricing?: boolean;
  failImageCleanup?: boolean;
  failRowCleanup?: boolean;
}

export interface MockDaoState {
  counter: number;
  certs: Map<string, number>;
  uploads: string[];
  deletedImages: string[];
  deletedRows: string[];
  createdNumbers: number[];
  pricingWrites: Array<{ slabId: string; write: SlabPricingWrite }>;
}

function baseSlab(num: number, input: SlabInput, frontExt: string, backExt: string | null): Slab {
  return {
    id: `slab-${num}`,
    inventory_number: num,
    card_name: input.card_name,
    final_value_cents: input.final_value_cents,
    quick_sale_value_cents: input.quick_sale_value_cents,
    replacement_value_cents: input.replacement_value_cents,
    grader: input.grader,
    grade: input.grade,
    grade_label: input.grade_label,
    certification_number: input.certification_number,
    set_name: input.set_name,
    card_number: input.card_number,
    year: input.year,
    language: input.language,
    rarity: input.rarity,
    variation: input.variation,
    label_description: input.label_description,
    label_accuracy: input.label_accuracy,
    verification_status: input.verification_status,
    valuation_confidence: input.valuation_confidence,
    valuation_provenance: input.valuation_provenance,
    duplicate_status: input.duplicate_status,
    pricecharting_product_id: input.pricecharting_product_id,
    pricecharting_product_name: input.pricecharting_product_name,
    pricecharting_grade_field: input.pricecharting_grade_field,
    pricecharting_value_cents: input.pricecharting_value_cents,
    pricecharting_sales_volume: input.pricecharting_sales_volume,
    pricecharting_match_status: input.pricecharting_match_status,
    price_variance_percent: input.price_variance_percent,
    front_image_path: `slabs/${num}/front.${frontExt}`,
    back_image_path: backExt ? `slabs/${num}/back.${backExt}` : null,
    notes: input.notes,
    date_valued: input.date_valued,
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
  };
}

export function makeMockDao(opts: MockDaoOptions = {}): { dao: SlabDataAccess; state: MockDaoState } {
  const state: MockDaoState = {
    counter: 0,
    certs: new Map(Object.entries(opts.existingCerts ?? {})),
    uploads: [],
    deletedImages: [],
    deletedRows: [],
    createdNumbers: [],
    pricingWrites: [],
  };

  const dao: SlabDataAccess = {
    async checkCertification(grader, cert) {
      const key = certCompositeKey(grader, cert);
      const n = key ? state.certs.get(key) : undefined;
      return n !== undefined ? { id: `slab-${n}`, inventory_number: n } : null;
    },
    async createSlabRow(input, frontExt, backExt) {
      if (opts.createError) return { data: null, error: opts.createError };
      // Grader-scoped, normalized composite key mirrors the DB unique index.
      const key = certCompositeKey(input.grader, input.certification_number);
      if (key && state.certs.has(key)) {
        return {
          data: null,
          error: { code: "DUPLICATE_CERTIFICATION", message: "Duplicate certification.", existing_inventory_number: state.certs.get(key) },
        };
      }
      // Atomic assignment (single-threaded JS mirrors the DB advisory lock).
      state.counter += 1;
      const num = state.counter;
      state.createdNumbers.push(num);
      if (key) state.certs.set(key, num);
      return { data: baseSlab(num, input, frontExt, backExt), error: null };
    },
    async uploadImage(path, _blob) {
      state.uploads.push(path);
      if (opts.failUpload === "front" && path.includes("/front.")) return { error: { message: "front upload failed" } };
      if (opts.failUpload === "back" && path.includes("/back.")) return { error: { message: "back upload failed" } };
      return { error: null };
    },
    async deleteImages(paths) {
      state.deletedImages.push(...paths);
      if (opts.failImageCleanup) throw new Error("image cleanup failed");
    },
    async deleteSlabRow(id) {
      state.deletedRows.push(id);
      if (opts.failRowCleanup) throw new Error("row cleanup failed");
    },
    async applySlabPricing(slabId, write) {
      if (opts.failPricing) throw new Error("pricing write failed");
      state.pricingWrites.push({ slabId, write });
      return !opts.stalePricing;
    },
  };

  return { dao, state };
}

/** A minimal valid SlabInput for save tests. */
export function validInput(overrides: Partial<SlabInput> = {}): SlabInput {
  return {
    card_name: "Charizard",
    set_name: "Base Set",
    card_number: "4",
    year: 1999,
    language: "English",
    rarity: "Holo Rare",
    variation: "Holo",
    grader: "PSA",
    grade: "9",
    grade_label: "MINT",
    certification_number: "12345678",
    label_description: "1999 Pokemon Base Set Charizard-Holo #4 PSA 9",
    label_accuracy: "accurate",
    verification_status: "verified",
    final_value_cents: 12500,
    quick_sale_value_cents: 10000,
    replacement_value_cents: 15000,
    valuation_confidence: "high",
    valuation_provenance: "pricecharting_exact_tier",
    price_variance_percent: 0,
    notes: null,
    date_valued: "2026-07-10T00:00:00Z",
    pricecharting_product_id: "6910",
    pricecharting_product_name: "Charizard #4",
    pricecharting_grade_field: "graded-price",
    pricecharting_value_cents: 12500,
    pricecharting_sales_volume: 42,
    pricecharting_match_status: "exact",
    duplicate_status: "unique",
    ...overrides,
  };
}

export function image(ext = "jpg"): { blob: Blob; ext: string } {
  return { blob: new Blob(["binary"], { type: `image/${ext === "jpg" ? "jpeg" : ext}` }), ext };
}
