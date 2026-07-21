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
const STORAGE_DELETE_BATCH_SIZE = 1000;

export interface PurgeSlabResult {
  slab_id: string;
  front_image_path: string | null;
  back_image_path: string | null;
}

export interface StorageCleanupResult {
  removed: number;
  pending: number;
  errors: string[];
}

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  return [...new Set(paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0))];
}

function chunks<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

async function acknowledgeStoragePaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await sb.rpc("acknowledge_slab_storage_cleanup", { p_paths: paths });
  if (error) throw new Error(`Storage cleanup acknowledgement failed: ${error.message}`);
}

async function recordStorageFailure(paths: string[], message: string): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await sb.rpc("record_slab_storage_cleanup_failure", {
    p_paths: paths,
    p_error: message,
  });
  if (error) throw new Error(`Storage cleanup failure could not be recorded: ${error.message}`);
}

async function removeQueuedStoragePaths(paths: string[]): Promise<StorageCleanupResult> {
  const targets = uniquePaths(paths);
  const errors: string[] = [];
  let removed = 0;
  let pending = 0;

  for (const batch of chunks(targets, STORAGE_DELETE_BATCH_SIZE)) {
    const { error } = await sb.storage.from(BUCKET).remove(batch);
    if (error) {
      pending += batch.length;
      errors.push(error.message);
      try {
        await recordStorageFailure(batch, error.message);
      } catch (recordError) {
        errors.push(recordError instanceof Error ? recordError.message : "Storage cleanup failure could not be recorded.");
      }
      continue;
    }

    try {
      await acknowledgeStoragePaths(batch);
      removed += batch.length;
    } catch (ackError) {
      // The objects are already gone, but the durable queue entry remains. A later
      // retry safely removes the now-missing paths and acknowledges them.
      pending += batch.length;
      errors.push(ackError instanceof Error ? ackError.message : "Storage cleanup acknowledgement failed.");
    }
  }

  return { removed, pending, errors };
}

export async function retryPendingSlabStorageCleanup(): Promise<StorageCleanupResult> {
  const { data, error } = await sb.rpc("list_pending_slab_storage_cleanup");
  if (error) throw new Error(error.message);
  const rows = Array.isArray(data) ? data : [];
  const paths = rows.map((row) => {
    if (!row || typeof row !== "object") return null;
    return (row as Record<string, unknown>).storage_path;
  });
  return removeQueuedStoragePaths(paths.filter((path): path is string => typeof path === "string"));
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

export async function purgeSlabs(ids: string[]): Promise<{ purged: number; storageCleanup: StorageCleanupResult }> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) throw new Error("Select at least one slab.");

  const { data, error } = await sb.rpc("purge_slabs", { p_ids: uniqueIds });
  if (error) {
    if (/HARD_DELETE_DISABLED/i.test(error.message)) {
      throw new Error("Permanent deletion is disabled. Turn on the admin checkbox first.");
    }
    if (/SLAB_NOT_FOUND_OR_DUPLICATE_INPUT/i.test(error.message)) {
      throw new Error("The selected inventory changed before deletion. Refresh and try again; no records were deleted.");
    }
    throw new Error(error.message);
  }

  const rows = (Array.isArray(data) ? data : []) as PurgeSlabResult[];
  if (rows.length !== uniqueIds.length) {
    throw new Error("The database returned an incomplete purge result. Storage cleanup was not attempted.");
  }

  const paths = uniquePaths(rows.flatMap((row) => [row.front_image_path, row.back_image_path]));
  const storageCleanup = await removeQueuedStoragePaths(paths);
  return { purged: rows.length, storageCleanup };
}
