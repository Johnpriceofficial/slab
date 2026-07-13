/**
 * Supabase-backed data access for slabs. The `slabs`/`slab_comps` tables and the
 * RPCs are newer than the generated Database types, so calls go through a
 * narrowly-cast client. Public functions still return the strong `Slab` types.
 */

import { supabase } from "@/integrations/supabase/client";
import type { Slab, SlabComp, SlabCompInput, SlabInput } from "./types";
import type { SlabDataAccess, SlabDataError } from "./save-slab";
import { buildPricingPersist } from "./pricing-tiers";
import { resolveRefreshProduct, buildRefreshScalars } from "./pricing-refresh";
import type {
  SearchResponse,
  ValueResponse,
  OfferImageResponse,
  LookupResponse,
  HandlerErrorBody,
} from "@/server/pricecharting/handler";
import type { AnalyzeResult, AnalyzeErrorBody, AnalyzeInput } from "@/server/analyze-slab/handler";

// The generated types predate these tables; use a loosely-typed handle.
type AnyClient = {
  from: (table: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => any;
  storage: typeof supabase.storage;
  functions: typeof supabase.functions;
};
const sb = supabase as unknown as AnyClient;

const BUCKET = "slab-images";

/* ----------------------------- write path ------------------------------ */

function mapCreateError(error: { message?: string; code?: string; details?: string } | null): SlabDataError | null {
  if (!error) return null;
  const msg = error.message ?? "Unknown database error";
  if (error.code === "23505" || /DUPLICATE_CERTIFICATION/i.test(msg)) {
    const existing = error.details ? Number(String(error.details).replace(/[^0-9]/g, "")) : undefined;
    return { code: "DUPLICATE_CERTIFICATION", message: "Duplicate certification number.", existing_inventory_number: existing };
  }
  if (error.code === "42501" || /NOT_AUTHORIZED/i.test(msg)) {
    return { code: "NOT_AUTHORIZED", message: "You do not have permission to add slabs." };
  }
  return { message: msg };
}

/** The production SlabDataAccess implementation used by the intake page. */
export const supabaseSlabDataAccess: SlabDataAccess = {
  async checkCertification(grader: string | null | undefined, cert: string) {
    const { data, error } = await sb.rpc("check_slab_certification", { p_grader: grader ?? "", p_cert: cert });
    if (error || !data || (Array.isArray(data) && data.length === 0)) return null;
    const row = Array.isArray(data) ? data[0] : data;
    return { id: row.id as string, inventory_number: row.inventory_number as number };
  },

  async createSlabRow(input: SlabInput, frontExt: string, backExt: string | null) {
    const { data, error } = await sb.rpc("create_slab", {
      p: input as unknown as Record<string, unknown>,
      p_front_ext: frontExt,
      p_back_ext: backExt,
    });
    const mapped = mapCreateError(error);
    if (mapped) return { data: null, error: mapped };
    // RPC returning a single composite row may arrive as an object or 1-elem array.
    const row = Array.isArray(data) ? data[0] : data;
    return { data: (row ?? null) as Slab | null, error: null };
  },

  async uploadImage(path: string, blob: Blob) {
    const { error } = await sb.storage
      .from(BUCKET)
      .upload(path, blob, { upsert: false, contentType: (blob as Blob).type || "image/jpeg" });
    return { error: error ? { message: error.message } : null };
  },

  async deleteImages(paths: string[]) {
    if (paths.length === 0) return;
    await sb.storage.from(BUCKET).remove(paths);
  },

  async deleteSlabRow(id: string) {
    await sb.from("slabs").delete().eq("id", id);
  },

  async applySlabPricing(slabId: string, pricing) {
    // Stale-write guarded server-side: an older retrieved_at never overwrites
    // newer. Tiers AND scalar mirror fields commit atomically under the one
    // guard. Returns true when the write was applied, false when stale-rejected.
    const { data, error } = await sb.rpc("apply_slab_pricing", {
      p_slab_id: slabId,
      p_tiers: pricing.persist as unknown as Record<string, unknown>,
      p_raw: (pricing.raw ?? null) as unknown as Record<string, unknown> | null,
      p_priced_at: pricing.persist.retrieved_at,
      p_scalars: (pricing.scalars ?? null) as unknown as Record<string, unknown> | null,
    });
    if (error) throw new Error(error.message);
    return data === true;
  },
};

/* ------------------------------ read path ------------------------------ */

export interface SlabQuery {
  search?: string;
  grader?: string;
  grade?: string;
  language?: string;
  verification_status?: string;
  duplicate_status?: string;
  minValueCents?: number | null;
  maxValueCents?: number | null;
  /** Archived slabs are hidden from active inventory unless this is true. */
  includeArchived?: boolean;
  sortKey?: keyof Slab;
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export async function fetchSlabs(query: SlabQuery = {}): Promise<{ rows: Slab[]; total: number }> {
  const page = query.page ?? 0;
  const pageSize = query.pageSize ?? 50;
  let q = sb.from("slabs").select("*", { count: "exact" });

  if (query.search && query.search.trim()) {
    const s = query.search.trim().replace(/[%,]/g, "");
    q = q.or(
      `card_name.ilike.%${s}%,certification_number.ilike.%${s}%,set_name.ilike.%${s}%,card_number.ilike.%${s}%`,
    );
  }
  if (query.grader) q = q.eq("grader", query.grader);
  if (query.grade) q = q.eq("grade", query.grade);
  if (query.language) q = q.eq("language", query.language);
  if (query.verification_status) q = q.eq("verification_status", query.verification_status);
  if (query.duplicate_status) q = q.eq("duplicate_status", query.duplicate_status);
  if (query.minValueCents != null) q = q.gte("final_value_cents", query.minValueCents);
  if (query.maxValueCents != null) q = q.lte("final_value_cents", query.maxValueCents);
  // Hide archived slabs from active inventory by default.
  if (!query.includeArchived) q = q.is("archived_at", null);

  const sortKey = query.sortKey ?? "inventory_number";
  q = q.order(sortKey as string, { ascending: (query.sortDir ?? "asc") === "asc" });
  q = q.range(page * pageSize, page * pageSize + pageSize - 1);

  const { data, error, count } = await q;
  if (error) throw error;
  return { rows: (data ?? []) as Slab[], total: count ?? 0 };
}

/** Fetch all slabs (dashboard + export). Capped high enough for ~1,000 slabs. */
export async function fetchAllSlabs(): Promise<Slab[]> {
  const { data, error } = await sb
    .from("slabs")
    .select("*")
    .order("inventory_number", { ascending: true })
    .range(0, 9999);
  if (error) throw error;
  return (data ?? []) as Slab[];
}

export async function fetchSlabById(id: string): Promise<Slab | null> {
  const { data, error } = await sb.from("slabs").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data ?? null) as Slab | null;
}

export async function fetchAdjacentSlabs(
  inventoryNumber: number,
): Promise<{ prev: Slab | null; next: Slab | null }> {
  const prevP = sb
    .from("slabs")
    .select("*")
    .lt("inventory_number", inventoryNumber)
    .order("inventory_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextP = sb
    .from("slabs")
    .select("*")
    .gt("inventory_number", inventoryNumber)
    .order("inventory_number", { ascending: true })
    .limit(1)
    .maybeSingle();
  const [{ data: prev }, { data: next }] = await Promise.all([prevP, nextP]);
  return { prev: (prev ?? null) as Slab | null, next: (next ?? null) as Slab | null };
}

/** Update mutable slab fields (valuation, status, notes). Money in cents. */
export async function updateSlab(id: string, patch: Partial<Slab>): Promise<Slab | null> {
  const { data, error } = await sb.from("slabs").update(patch).eq("id", id).select("*").maybeSingle();
  if (error) throw error;
  return (data ?? null) as Slab | null;
}

export async function fetchComps(slabId: string): Promise<SlabComp[]> {
  const { data, error } = await sb
    .from("slab_comps")
    .select("*")
    .eq("slab_id", slabId)
    .order("sale_date", { ascending: false });
  if (error) throw error;
  return (data ?? []) as SlabComp[];
}

export async function fetchAllComps(): Promise<SlabComp[]> {
  const { data, error } = await sb.from("slab_comps").select("*").order("sale_date", { ascending: false }).range(0, 99999);
  if (error) throw error;
  return (data ?? []) as SlabComp[];
}

/* ----------------------- sales-comp write path ------------------------- */

export async function insertComp(slabId: string, input: SlabCompInput): Promise<SlabComp> {
  const { data, error } = await sb
    .from("slab_comps")
    .insert({ ...input, slab_id: slabId })
    .select("*")
    .single();
  if (error) throw error;
  return data as SlabComp;
}

export async function updateComp(id: string, patch: Partial<SlabCompInput>): Promise<SlabComp> {
  const { data, error } = await sb.from("slab_comps").update(patch).eq("id", id).select("*").single();
  if (error) throw error;
  return data as SlabComp;
}

export async function deleteComp(id: string): Promise<void> {
  const { error } = await sb.from("slab_comps").delete().eq("id", id);
  if (error) throw error;
}

/* -------------------------- archive / deletion ------------------------- */

/** Archive a slab (preserves inventory number, comps, images, and history). */
export async function archiveSlab(id: string): Promise<Slab> {
  const { data, error } = await sb.rpc("archive_slab", { p_id: id });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as Slab;
}

export async function unarchiveSlab(id: string): Promise<Slab> {
  const { data, error } = await sb.rpc("unarchive_slab", { p_id: id });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as Slab;
}

export interface HardDeleteReport {
  row_deleted: boolean;
  images_removed: string[];
  /** Non-empty when some storage objects could not be removed (orphaned). */
  image_errors: string[];
}

/**
 * Hard-delete a TEMPORARY TEST record: removes comps + the slab row (RPC), then
 * deletes the storage images. Reports partial-cleanup failures clearly — a
 * failed image removal does not silently pass.
 */
export async function hardDeleteSlab(id: string): Promise<HardDeleteReport> {
  const { data, error } = await sb.rpc("hard_delete_slab", { p_id: id });
  if (error) throw error; // nothing deleted — surface to caller
  const row = Array.isArray(data) ? data[0] : data;
  const paths = [row?.front_image_path, row?.back_image_path].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );

  const image_errors: string[] = [];
  const images_removed: string[] = [];
  if (paths.length > 0) {
    const { error: rmErr } = await sb.storage.from(BUCKET).remove(paths);
    if (rmErr) image_errors.push(rmErr.message);
    else images_removed.push(...paths);
  }
  return { row_deleted: true, images_removed, image_errors };
}

export async function signedImageUrl(path: string | null, expiresSeconds = 3600): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, expiresSeconds);
  if (error || !data) return null;
  return data.signedUrl ?? null;
}

/* ------------------------- PriceCharting (server) ---------------------- */

export interface PriceChartingSearchArgs {
  card_name?: string;
  set?: string;
  card_number?: string;
  year?: number | string;
  language?: string;
  variation?: string;
  grader?: string;
  grade?: string | number;
}

/** Invoke the server-side edge function. The browser never sees the token. */
export async function priceChartingSearch(
  args: PriceChartingSearchArgs,
): Promise<SearchResponse | HandlerErrorBody> {
  const { data, error } = await sb.functions.invoke("pricecharting-search", {
    body: { action: "search", ...args },
  });
  if (error) return { status: "error", error_code: "NETWORK_ERROR", message: error.message, retryable: true };
  return data as SearchResponse | HandlerErrorBody;
}

/* --------------------------- Slab image analysis ----------------------- */

/** Base64-encode a Blob for transport to the analyze-slab edge function. */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Send the slab images to the server-side analyzer. Returns PROPOSED identity
 * fields with confidence — never saved automatically; the operator confirms or
 * edits before any PriceCharting lookup or inventory save. The AI-provider key
 * lives only in the edge function.
 */
export async function analyzeSlab(
  front: { blob: Blob; mime: string },
  back: { blob: Blob; mime: string } | null,
): Promise<AnalyzeResult | AnalyzeErrorBody> {
  const body: AnalyzeInput = {
    front_image_base64: await blobToBase64(front.blob),
    front_mime: front.mime,
  };
  if (back) {
    body.back_image_base64 = await blobToBase64(back.blob);
    body.back_mime = back.mime;
  }
  const { data, error } = await sb.functions.invoke("analyze-slab", { body });
  if (error) return { status: "error", error_code: "NETWORK_ERROR", message: error.message };
  return data as AnalyzeResult | AnalyzeErrorBody;
}

export async function priceChartingValue(
  productId: string,
  grader?: string,
  grade?: string | number,
): Promise<ValueResponse | HandlerErrorBody> {
  const { data, error } = await sb.functions.invoke("pricecharting-search", {
    body: { action: "value", product_id: productId, grader, grade },
  });
  if (error) return { status: "error", error_code: "NETWORK_ERROR", message: error.message, retryable: true };
  return data as ValueResponse | HandlerErrorBody;
}

/**
 * Fetch a seller listing photo for a confirmed product, for visual (metadata +
 * photo) confirmation. Best-effort: the image is a marketplace seller's photo of
 * their copy of the same catalog product — often absent — never a canonical image.
 */
export async function priceChartingOfferImage(
  productId: string,
): Promise<OfferImageResponse | HandlerErrorBody> {
  const { data, error } = await sb.functions.invoke("pricecharting-search", {
    body: { action: "offer_image", product_id: productId },
  });
  if (error) return { status: "error", error_code: "NETWORK_ERROR", message: error.message, retryable: true };
  return data as OfferImageResponse | HandlerErrorBody;
}

/**
 * Manual recovery / confirmed-id-first lookup: fetch one product by id or URL and
 * validate it against the slab identity (same hard-conflict protections). Returns
 * the product + conflicts + a best-effort offer image + whether it's safe to link.
 */
export async function priceChartingLookup(
  idOrUrl: string,
  identity: PriceChartingSearchArgs,
): Promise<LookupResponse | HandlerErrorBody> {
  const trimmed = idOrUrl.trim();
  const isUrl = /^https?:\/\//i.test(trimmed) || trimmed.includes("/");
  const { data, error } = await sb.functions.invoke("pricecharting-search", {
    body: {
      action: "lookup",
      ...identity,
      ...(isUrl ? { product_url: trimmed } : { product_id: trimmed }),
    },
  });
  if (error) return { status: "error", error_code: "NETWORK_ERROR", message: error.message, retryable: true };
  return data as LookupResponse | HandlerErrorBody;
}

export interface RefreshPricingResult {
  status: "applied" | "stale" | "needs_confirmation" | "no_product" | "error";
  guide_cents?: number | null;
  product_name?: string | null;
  message?: string;
}

/**
 * Re-fetch and persist PriceCharting pricing for an EXISTING slab, so a card
 * saved before tier persistence (or one whose market moved) shows the full,
 * current grade table. Re-values the already-confirmed product directly; with no
 * stored product it accepts only an auto-confirmed search, else defers to manual
 * confirmation. Persists the refreshed tiers (stale-guarded server-side) and the
 * scalar PriceCharting fields — WITHOUT overwriting a hand-entered graded guide
 * or the operator's approved Final/Quick/Replacement values.
 */
export async function refreshSlabPricing(slab: Slab): Promise<RefreshPricingResult> {
  try {
    let search: SearchResponse | null = null;
    if (!slab.pricecharting_product_id) {
      const res = await priceChartingSearch({
        card_name: slab.card_name ?? undefined,
        set: slab.set_name ?? undefined,
        card_number: slab.card_number ?? undefined,
        year: slab.year ?? undefined,
        language: slab.language ?? undefined,
        variation: slab.variation ?? undefined,
        grader: slab.grader ?? undefined,
        grade: slab.grade ?? undefined,
      });
      if (res.status === "error") return { status: "error", message: res.message };
      search = res;
    }

    const resolution = resolveRefreshProduct(slab.pricecharting_product_id, slab.pricecharting_match_status, search);
    if (resolution.kind === "needs_confirmation") {
      return { status: "needs_confirmation", message: "No confident match — confirm the product in the intake screen first." };
    }
    if (resolution.kind === "no_product") {
      return { status: "no_product", message: "No PriceCharting product is linked and none could be matched automatically." };
    }

    const value = await priceChartingValue(resolution.product_id, slab.grader ?? undefined, slab.grade ?? undefined);
    if (value.status === "error") return { status: "error", message: value.message };

    // ONE atomic, stale-guarded write: tiers + raw + the scalar mirror fields all
    // commit together under the retrieved_at guard. A concurrent newer refresh can
    // never be half-clobbered, and a stale one is rejected wholesale (applied=false).
    const persist = buildPricingPersist(
      value.available_values_cents ?? null,
      { grader: slab.grader, grade: slab.grade, grade_label: slab.grade_label },
      new Date().toISOString(),
    );
    const scalars = buildRefreshScalars(slab, value, resolution.match_status);
    const applied = await supabaseSlabDataAccess.applySlabPricing!(slab.id, { persist, raw: value, scalars });
    if (!applied) {
      return { status: "stale", message: "A newer pricing update already applied — nothing was changed." };
    }
    return { status: "applied", guide_cents: value.guide_value_cents, product_name: value.product_name };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : "Refresh failed." };
  }
}
