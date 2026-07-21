import { supabase } from "@/integrations/supabase/client";
import type { Slab } from "./types";

type QueryResult<T> = Promise<{ data: T; error: { message: string } | null }>;
type AnyClient = {
  from: (table: string) => {
    select: (columns: string) => { eq: (column: string, value: unknown) => { maybeSingle: () => QueryResult<Record<string, unknown> | null> } };
    update: (patch: Record<string, unknown>) => { eq: (column: string, value: unknown) => { select: (columns: string) => { single: () => QueryResult<Record<string, unknown>> } } };
  };
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  storage: typeof supabase.storage;
};

const sb = supabase as unknown as AnyClient;
const BUCKET = "slab-images";

export interface PurgeSlabResult {
  slab_id: string;
  front_image_path: string | null;
  back_image_path: string | null;
}

export async function fetchPermanentDeleteEnabled(): Promise<boolean> {
  const { data, error } = await sb.from("slab_settings").select("allow_hard_delete").eq("id", true).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.allow_hard_delete === true;
}

export async function setPermanentDeleteEnabled(enabled: boolean): Promise<boolean> {
  const { data, error } = await sb.from("slab_settings")
    .update({ allow_hard_delete: enabled, updated_at: new Date().toISOString() })
    .eq("id", true)
    .select("allow_hard_delete")
    .single();
  if (error) throw new Error(error.message);
  return data.allow_hard_delete === true;
}

export async function reassignSlabInventoryId(slabId: string, sequence: number): Promise<Slab> {
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error("Inventory ID must be a positive whole number.");
  const { data, error } = await sb.rpc("reassign_slab_inventory_id", {
    p_slab_id: slabId,
    p_sequence: sequence,
  });
  if (error) {
    if (/INVENTORY_ID_ALREADY_USED|duplicate key/i.test(error.message)) {
      throw new Error(`S${String(sequence).padStart(4, "0")} is already assigned to another slab.`);
    }
    throw new Error(error.message);
  }
  return (Array.isArray(data) ? data[0] : data) as Slab;
}

export async function compactSlabInventoryIds(): Promise<number> {
  const { data, error } = await sb.rpc("compact_slab_inventory_ids");
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

export async function purgeSlabs(ids: string[]): Promise<{ purged: number; storageErrors: string[] }> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) throw new Error("Select at least one slab.");

  const { data, error } = await sb.rpc("purge_slabs", { p_ids: uniqueIds });
  if (error) {
    if (/HARD_DELETE_DISABLED/i.test(error.message)) {
      throw new Error("Permanent deletion is disabled. Turn on the admin checkbox first.");
    }
    throw new Error(error.message);
  }

  const rows = (Array.isArray(data) ? data : []) as PurgeSlabResult[];
  const paths = rows.flatMap((row) => [row.front_image_path, row.back_image_path]).filter((path): path is string => !!path);
  const storageErrors: string[] = [];
  if (paths.length > 0) {
    const { error: storageError } = await sb.storage.from(BUCKET).remove(paths);
    if (storageError) storageErrors.push(storageError.message);
  }
  return { purged: rows.length, storageErrors };
}
