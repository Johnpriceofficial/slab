import type { SelectedPriceCharting } from "@/components/slabs/PriceChartingPanel";
import type { ImageSource } from "@/server/pricecharting/handler";
import type { AnalyzeResult } from "@/server/analyze-slab/handler";
import type { SlabImageState } from "./image-state";
import type { ValuationProvenance } from "./valuation-provenance";

const DB_NAME = "gradedcardvalue-local-drafts";
const DB_VERSION = 1;
const STORE_NAME = "drafts";
const DRAFT_KEY = "new-slab-audit";
const DRAFT_VERSION = 1;

export interface NewSlabVisualDraft {
  product_id: string;
  status: "user_confirmed" | "user_rejected";
  imageUrl: string | null;
  imageSource: ImageSource;
}

export interface NewSlabRejectedDraft {
  product_id: string;
  imageUrl: string | null;
  imageSource: ImageSource;
  reason: string;
  note: string;
}

export interface NewSlabDraftSnapshot {
  front: SlabImageState | null;
  back: SlabImageState | null;
  id: Record<string, string>;
  val: Record<string, string>;
  pc: SelectedPriceCharting | null;
  visual: NewSlabVisualDraft | null;
  rejected: NewSlabRejectedDraft | null;
  analysis: AnalyzeResult | null;
  valProvenance: ValuationProvenance;
  valStale: boolean;
  pcStale: boolean;
}

interface StoredImage {
  original_blob: Blob;
  original_name: string;
  original_type: string;
  original_last_modified: number;
  normalized_blob: Blob;
  normalized_name: string;
  normalized_type: string;
  normalized_last_modified: number;
  ext: string;
}

interface StoredDraft extends Omit<NewSlabDraftSnapshot, "front" | "back"> {
  version: number;
  updated_at: string;
  front: StoredImage | null;
  back: StoredImage | null;
}

interface StoredEnvelope {
  key: string;
  value: StoredDraft;
}

let memoryDraft: StoredDraft | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function serializeImage(image: SlabImageState | null): StoredImage | null {
  if (!image) return null;
  return {
    original_blob: image.originalFile,
    original_name: image.originalFile.name,
    original_type: image.originalFile.type,
    original_last_modified: image.originalFile.lastModified,
    normalized_blob: image.file,
    normalized_name: image.file.name,
    normalized_type: image.file.type,
    normalized_last_modified: image.file.lastModified,
    ext: image.ext,
  };
}

function hydrateImage(image: StoredImage | null): SlabImageState | null {
  if (!image) return null;
  const originalFile = new File([image.original_blob], image.original_name, {
    type: image.original_type,
    lastModified: image.original_last_modified,
  });
  const file = new File([image.normalized_blob], image.normalized_name, {
    type: image.normalized_type,
    lastModified: image.normalized_last_modified,
  });
  const previewUrl = typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "";
  return { originalFile, file, previewUrl, ext: image.ext };
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function readStoredDraft(): Promise<StoredDraft | null> {
  const db = await openDatabase();
  if (!db) return memoryDraft;
  return new Promise((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(DRAFT_KEY);
    request.onsuccess = () => resolve((request.result as StoredEnvelope | undefined)?.value ?? memoryDraft);
    request.onerror = () => resolve(memoryDraft);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => db.close();
    transaction.onabort = () => db.close();
  });
}

async function writeStoredDraft(value: StoredDraft): Promise<void> {
  memoryDraft = value;
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({ key: DRAFT_KEY, value } satisfies StoredEnvelope);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      resolve();
    };
    transaction.onabort = () => {
      db.close();
      resolve();
    };
  });
}

async function deleteStoredDraft(): Promise<void> {
  memoryDraft = null;
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(DRAFT_KEY);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      resolve();
    };
    transaction.onabort = () => {
      db.close();
      resolve();
    };
  });
}

/** Save the complete in-progress audit, including both image blobs. Writes are ordered. */
export async function saveNewSlabDraft(snapshot: NewSlabDraftSnapshot): Promise<void> {
  const stored: StoredDraft = {
    ...snapshot,
    version: DRAFT_VERSION,
    updated_at: new Date().toISOString(),
    front: serializeImage(snapshot.front),
    back: serializeImage(snapshot.back),
  };
  writeQueue = writeQueue.catch(() => undefined).then(() => writeStoredDraft(stored));
  await writeQueue;
}

/** Restore the most recent in-progress audit and mint fresh object URLs for previews. */
export async function loadNewSlabDraft(): Promise<NewSlabDraftSnapshot | null> {
  await writeQueue.catch(() => undefined);
  const stored = await readStoredDraft();
  if (!stored || stored.version !== DRAFT_VERSION) return null;
  const { version: _version, updated_at: _updatedAt, front, back, ...rest } = stored;
  return {
    ...rest,
    front: hydrateImage(front),
    back: hydrateImage(back),
  };
}

/** Remove the local audit after a successful save or before staging a deliberate new scan. */
export async function clearNewSlabDraft(): Promise<void> {
  writeQueue = writeQueue.catch(() => undefined).then(deleteStoredDraft);
  await writeQueue;
}
