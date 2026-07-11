/**
 * Supabase-backed data access for slabs. The `slabs`/`slab_comps` tables and the
 * RPCs are newer than the generated Database types, so calls go through a
 * narrowly-cast client. Public functions still return the strong `Slab` types.
 */

import { supabase } from "@/integrations/supabase/client";
import type { Slab, SlabComp, SlabInput } from "./types";
import type { SlabDataAccess, SlabDataError } from "./save-slab";
import type {
  SearchResponse,
  ValueResponse,
  HandlerErrorBody,
} from "@/server/pricecharting/handler";

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
  async checkCertification(cert: string) {
    const { data, error } = await sb.rpc("check_slab_certification", { p_cert: cert });
    if (error || !data || (Array.isArray(data) && data.length === 0)) return null;
    const row = Array.isArray(data) ? data[0] : data;
    return { id: row.id as string, inventory_number: row.inventory_number as number };
  },

  async createSlabRow(input: SlabInput, frontExt: string, backExt: string) {
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
