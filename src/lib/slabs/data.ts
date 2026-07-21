/**
 * Supabase-backed data access for slabs. The `slabs`/`slab_comps` tables and the
 * RPCs are newer than the generated Database types, so calls go through a
 * narrowly-cast client. Public functions still return the strong `Slab` types.
 */

import { supabase } from "@/integrations/supabase/client";
import type { Slab, SlabComp, SlabCompInput, SlabInput, PriceChartingOffer } from "./types";
import type { MarketplaceInput, MarketplaceHandlerBody, MarketplaceSnapshot } from "@/server/pricecharting/marketplace-handler";
import type { SlabDataAccess, SlabDataError } from "./save-slab";
import { buildPricingPersist } from "./pricing-tiers";
import { resolveRefreshProduct, buildRefreshScalars } from "./pricing-refresh";
import { parseInventoryQuery } from "./inventory-code";
import { buildConfirmationPatch, confirmationEventType, isRetryableConfirmationError } from "./confirmation-patch";
import type {
  SearchResponse,
  ValueResponse,
  OfferImageResponse,
  LookupResponse,
  HandlerErrorBody,
} from "@/server/pricecharting/handler";
import type { AnalyzeResult, AnalyzeErrorBody, AnalyzeInput } from "@/server/analyze-slab/handler";
import { buildDeterministicAnalysisVariants } from "./image-derivatives";

// The generated types predate these tables; use a loosely-typed handle.
type AnyClient = {
  from: (table: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => any;
  storage: typeof supabase.storage;
  functions: typeof supabase.functions;
};
const sb = supabase as unknown as AnyClient;

const BUCKET = "slab-images";

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function imageDimensions(blob: Blob): Promise<{ width: number | null; height: number | null }> {
  try {
    const bitmap = await createImageBitmap(blob);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dimensions;
  } catch {
    return { width: null, height: null };
  }
}

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

  async registerImageEvidence(slabId, role, original, normalized) {
    const [originalSha, originalSize, normalizedSha, normalizedSize] = await Promise.all([
      sha256Hex(original.blob), imageDimensions(original.blob), sha256Hex(normalized.blob), imageDimensions(normalized.blob),
    ]);
    const { data: imageRow, error: imageError } = await sb.from("slab_images").upsert({
      slab_id: slabId,
      image_role: role,
      storage_path: original.path,
      mime_type: original.mime,
      width: originalSize.width,
      height: originalSize.height,
      sha256: originalSha,
      is_original: true,
    }, { onConflict: "storage_path" }).select("id").single();
    if (imageError) throw new Error(`Original ${role} evidence could not be registered: ${imageError.message}`);
    if (normalized.path !== original.path) {
      if (!normalizedSize.width || !normalizedSize.height) throw new Error(`Normalized ${role} image dimensions are unreadable.`);
      const { error: derivativeError } = await sb.from("image_derivatives").upsert({
        slab_image_id: imageRow.id,
        derivative_type: "lossless_or_browser_decode",
        storage_path: normalized.path,
        transform_manifest: { version: 1, operation: "format_decode", generative: false },
        width: normalizedSize.width,
        height: normalizedSize.height,
        sha256: normalizedSha,
      }, { onConflict: "storage_path" });
      if (derivativeError) throw new Error(`Normalized ${role} derivative could not be registered: ${derivativeError.message}`);
    }
  },

  async deleteImages(paths: string[]) {
    if (paths.length === 0) return;
    const { error } = await sb.storage.from(BUCKET).remove(paths);
    if (error) throw new Error(`Image cleanup failed for ${paths.join(", ")}: ${error.message}`);
  },

  async deleteSlabRow(id: string) {
    const { error } = await sb.from("slabs").delete().eq("id", id);
    if (error) throw new Error(`Slab-row cleanup failed for ${id}: ${error.message}`);
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
    const filters = [
      `card_name.ilike.%${s}%`,
      `certification_number.ilike.%${s}%`,
      `set_name.ilike.%${s}%`,
      `card_number.ilike.%${s}%`,
      // Public identifier: match the full code ("S0001") or its numeric portion.
      `inventory_code.ilike.%${s.toUpperCase()}%`,
    ];
    const parsed = parseInventoryQuery(s);
    if (parsed) filters.push(`inventory_sequence.eq.${parsed.sequence}`);
    q = q.or(filters.join(","));
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

/**
 * Resolve a public inventory query ("S0001", "0001", "1") to the accessible
 * slab(s) via the ownership-scoped RPC. Used for QR codes, deep links, exports,
 * and Copilot lookups. Returns [] for free text or a non-slab prefix.
 */
export async function resolveSlabInventory(query: string): Promise<Slab[]> {
  const { data, error } = await sb.rpc("resolve_slab_inventory", { p_query: query });
  if (error) throw error;
  return (data ?? []) as Slab[];
}

export interface ResolvedInventoryItem {
  item_type: "slab" | "raw_card";
  id: string;
  inventory_code: string;
  inventory_sequence: number;
}

/**
 * Resolve a public inventory query across BOTH inventories: "S0001" → a slab,
 * "R0001" → a raw card, a bare number → both. Ownership-scoped by the RPC.
 */
export async function resolveInventory(query: string): Promise<ResolvedInventoryItem[]> {
  const { data, error } = await sb.rpc("resolve_inventory", { p_query: query });
  if (error) throw error;
  return (data ?? []) as ResolvedInventoryItem[];
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
  grade_label?: string;
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
  try {
    const variants = await buildDeterministicAnalysisVariants(front.blob);
    body.variants = await Promise.all(variants.map(async (variant) => ({
      label: variant.label,
      image_base64: await blobToBase64(variant.blob),
      mime: variant.mime,
    })));
  } catch {
    // The original remains valid evidence. A derivative failure must never
    // replace or corrupt it; analysis proceeds with originals only.
  }
  const { data, error } = await sb.functions.invoke("analyze-slab", { body });
  if (error) return { status: "error", error_code: "NETWORK_ERROR", message: error.message };
  return data as AnalyzeResult | AnalyzeErrorBody;
}

export async function linkAnalysisRun(runId: string, slabId: string): Promise<void> {
  const { error } = await sb.rpc("link_ai_analysis_run", { p_run_id: runId, p_slab_id: slabId });
  if (error) throw new Error(error.message);
}

export async function fetchPriceChartingOffers(slabId: string): Promise<PriceChartingOffer[]> {
  const { data, error } = await sb.from("pricecharting_offers").select("*").eq("slab_id", slabId).order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as PriceChartingOffer[];
}

export async function invokePriceChartingMarketplace(
  slabId: string,
  input: MarketplaceInput,
  eventType?: "published" | "edited" | "synced" | "shipped" | "feedback" | "ended" | "refunded",
): Promise<MarketplaceHandlerBody> {
  const { data, error } = await sb.functions.invoke("pricecharting-marketplace", { body: input });
  if (error) return { status: "error", error_code: "NETWORK_ERROR", message: error.message, retryable: true };
  const result = data as MarketplaceHandlerBody;
  if (result.status === "success" && result.snapshot) {
    const { error: applyError } = await sb.rpc("apply_pricecharting_offer_snapshot", {
      p_slab_id: slabId,
      p_snapshot: result.snapshot as MarketplaceSnapshot,
      p_event_type: eventType ?? (input.action === "publish" ? "published" : input.action === "details" ? "synced" : input.action),
    });
    if (applyError) return { status: "error", error_code: "PERSISTENCE_ERROR", message: applyError.message, retryable: true };
  }
  return result;
}

export async function syncAllPriceChartingOffers(): Promise<{ status: string; offers_seen?: number; offers_updated?: number; failed?: number; message?: string }> {
  const { data, error } = await sb.functions.invoke("pricecharting-marketplace", { body: { action: "sync_all" } });
  if (error) return { status: "error", message: error.message };
  return data as { status: string; offers_seen?: number; offers_updated?: number; failed?: number; message?: string };
}

export interface EbayReferenceItem {
  item_id: string | null;
  title: string | null;
  image_url: string | null;
  additional_images: string[];
  item_url: string | null;
  price: { value?: string; currency?: string } | null;
  source_label: "Reference Listing";
  market_label: "Active Asking Price";
  sold_comparable: false;
}

export async function ebayReferenceSearch(args: { query: string; card_name?: string; card_number?: string }): Promise<{
  status: "success" | "unavailable" | "error";
  items: EbayReferenceItem[];
  message?: string;
}> {
  const { data, error } = await sb.functions.invoke("ebay-reference-search", { body: args });
  if (error) return { status: "unavailable", items: [], message: "eBay reference images are not connected." };
  return data as { status: "success" | "unavailable" | "error"; items: EbayReferenceItem[]; message?: string };
}

export interface FieldEvidenceRow {
  id: string;
  field_name: string;
  value: string | null;
  normalized_value: string | null;
  confidence: number | null;
  readability: string | null;
  created_at: string;
}

export async function fetchFieldEvidence(slabId: string): Promise<FieldEvidenceRow[]> {
  const { data, error } = await sb.from("ai_field_evidence").select("id,field_name,value,normalized_value,confidence,readability,created_at").eq("slab_id", slabId).order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as FieldEvidenceRow[];
}

export async function fetchEbayAccounts(): Promise<Array<{ id: string; display_label: string | null; connection_status: string; privilege_status: string | null; connected_at: string | null }>> {
  const { data, error } = await sb.from("ebay_accounts").select("id,display_label,connection_status,privilege_status,connected_at").order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Per-resource sync cursors (account_discovery / orders / finances) — the
 *  authoritative "last synced" per operation, replacing the ambiguous shared one. */
export async function fetchEbaySyncCursors(accountId: string): Promise<Array<{ resource_type: string; cursor_value: string | null; last_synced_at: string | null }>> {
  const { data, error } = await sb.from("ebay_sync_cursors").select("resource_type,cursor_value,last_synced_at").eq("ebay_account_id", accountId);
  if (error) return [];
  return data ?? [];
}

export async function fetchIntegrationHealth(): Promise<{ failed_sync_jobs: number; unresolved_errors: number }> {
  const [{ count: failed }, { count: errors }] = await Promise.all([
    sb.from("pricecharting_sync_runs").select("id", { count: "exact", head: true }).eq("status", "failed"),
    sb.from("integration_errors").select("id", { count: "exact", head: true }).is("resolved_at", null),
  ]);
  return { failed_sync_jobs: failed ?? 0, unresolved_errors: errors ?? 0 };
}

export async function startEbayOAuth(): Promise<{ status: string; authorization_url?: string; message?: string }> {
  // Send a RELATIVE path: the callback's open-redirect guard only honors a
  // same-app relative path, so an absolute href would be dropped and the user
  // would land on the generic /slabs list (without the eBay panel/banner).
  const { data, error } = await sb.functions.invoke("ebay-oauth-start", { body: { redirect_after: window.location.pathname + window.location.search } });
  if (error) return { status: "unavailable", message: "eBay OAuth is not configured for this deployment." };
  return data as { status: string; authorization_url?: string; message?: string };
}

export async function ebaySellerOperation(
  functionName: "ebay-account-sync" | "ebay-list-item" | "ebay-revise-item" | "ebay-end-item" | "ebay-order-sync" | "ebay-fulfillment" | "ebay-finances-sync",
  body: Record<string, unknown>,
): Promise<Record<string, any>> {
  const { data, error } = await sb.functions.invoke(functionName, { body });
  if (error) return { status: "error", message: error.message };
  return (data ?? { status: "error", message: "eBay returned no response." }) as Record<string, any>;
}

/**
 * Full identity sent with a value request. The confirmed product page is part of
 * the canonical workflow, so the server needs the whole identity — the canonical
 * URL (to fetch the exact page), and card_number + language (to VERIFY the page is
 * the same card before any tier/artwork is trusted), plus set/name/year/variation
 * for persistence and audit. Every field is optional except product_id; empty
 * values are dropped so the server derives what it can.
 */
export interface PriceChartingValueArgs extends PriceChartingSearchArgs {
  product_id: string;
  canonical_url?: string | null;
}

export async function priceChartingValue(
  args: PriceChartingValueArgs,
): Promise<ValueResponse | HandlerErrorBody> {
  const { product_id, ...identity } = args;
  const body: Record<string, unknown> = { action: "value", product_id };
  for (const [k, v] of Object.entries(identity)) {
    if (v !== undefined && v !== null && v !== "") body[k] = v;
  }
  const { data, error } = await sb.functions.invoke("pricecharting-search", { body });
  if (error) return { status: "error", error_code: "NETWORK_ERROR", message: error.message, retryable: true };
  return data as ValueResponse | HandlerErrorBody;
}

/**
 * Fetch eligible PriceCharting Marketplace seller photos for a confirmed
 * product. The official Prices API does not expose catalog artwork; this path
 * never scrapes a public product page.
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

/** §4 Visual-confirmation + product-confirmation-source fields to persist on a slab. */
export interface PricechartingConfirmation {
  product_id: string | null;
  candidate_image_url: string | null;
  candidate_image_source: string | null; // 'marketplace_offer'|'none' (legacy rows may contain older values)
  candidate_image_type: string | null; // 'marketplace_offer_image' or null
  candidate_image_available: boolean;
  visual_confirmation_status: string; // not_available|not_reviewed|user_confirmed|user_rejected|metadata_auto_confirmed
  visual_confirmation_method: string | null; // 'side_by_side'
  /** Structured rejection reason (see VISUAL_REJECTION_REASONS), or null. */
  visual_rejection_reason: string | null;
  /** Free-text operator note accompanying the structured rejection reason. */
  visual_rejection_note: string | null;
  product_confirmation_source: string | null; // search_auto|search_manual|manual_product_id|manual_product_url
  scoring_version: number | null;
}

export type ConfirmationResult =
  | { status: "success" }
  | { status: "error"; message: string; retryable: boolean };

/**
 * Persist §4 confirmation state AND append an immutable audit event ATOMICALLY,
 * via a single SECURITY DEFINER RPC. Both the slab-state update and the append-only
 * audit insert happen in one transaction — either both land or neither does, so the
 * current state and the history can never diverge. The event table is append-only
 * (no UPDATE/DELETE policy) so history is never rewritten, and a visually REJECTED
 * product is never stamped as confirmed (enforced by buildConfirmationPatch).
 *
 * Errors are RETURNED (never swallowed) so the caller can surface a retryable UI.
 */
export async function recordPricechartingConfirmation(
  slabId: string,
  c: PricechartingConfirmation,
): Promise<ConfirmationResult> {
  const now = new Date().toISOString();
  const patch = buildConfirmationPatch(c, now, null); // actor is server-derived in the RPC
  const event = {
    event_type: confirmationEventType(c.visual_confirmation_status),
    product_id: c.product_id,
    source: c.product_confirmation_source,
    detail: c as unknown as Record<string, unknown>,
  };
  const { error } = await sb.rpc("record_pricecharting_confirmation", {
    p_slab_id: slabId,
    p_patch: patch,
    p_event: event,
  });
  if (error) {
    // Network / transient errors are retryable; a constraint or auth failure is not.
    return {
      status: "error",
      message: error.message ?? "Failed to record confirmation",
      retryable: isRetryableConfirmationError(error.message),
    };
  }
  return { status: "success" };
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
        grade_label: slab.grade_label ?? undefined,
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

    const value = await priceChartingValue({
      product_id: resolution.product_id,
      card_name: slab.card_name ?? undefined,
      set: slab.set_name ?? undefined,
      card_number: slab.card_number ?? undefined,
      year: slab.year ?? undefined,
      language: slab.language ?? undefined,
      variation: slab.variation ?? undefined,
      grader: slab.grader ?? undefined,
      grade: slab.grade ?? undefined,
      grade_label: slab.grade_label ?? undefined,
    });
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
