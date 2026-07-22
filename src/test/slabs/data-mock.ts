/**
 * Shared Supabase client mock for unit-testing src/lib/slabs/data.ts without a
 * live database. A single chainable "builder" fakes every query-builder method
 * data.ts calls (select/eq/order/range/is/gt/lt/limit/or/gte/lte/ilike/upsert/
 * insert/update/delete) and is awaitable directly (thenable) OR terminated with
 * .single()/.maybeSingle() — matching how each call site in data.ts actually
 * resolves it. `from` is queued so a test can hand back a different result per
 * call (e.g. fetchAdjacentSlabs makes two independent `.from("slabs")` calls).
 */
import { vi } from "vitest";

export interface BuilderResult {
  data?: unknown;
  error?: { message: string; code?: string; details?: string } | null;
  count?: number | null;
}

const CHAIN_METHODS = [
  "select", "eq", "order", "range", "is", "gt", "lt", "limit", "or", "gte", "lte", "ilike",
  "upsert", "insert", "update", "delete", "onConflict",
] as const;

export function makeBuilder(result: BuilderResult) {
  const resolved = { data: result.data ?? null, error: result.error ?? null, count: result.count ?? null };
  const builder: Record<string, unknown> = {};
  for (const method of CHAIN_METHODS) builder[method] = vi.fn(() => builder);
  builder.single = vi.fn(async () => resolved);
  builder.maybeSingle = vi.fn(async () => resolved);
  // Thenable: `await q` (no terminal method) resolves the same way.
  builder.then = (onFulfilled: (v: typeof resolved) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(resolved).then(onFulfilled, onRejected);
  return builder;
}

export function makeStorageBucket(overrides: {
  upload?: BuilderResult["error"] extends never ? never : { error: BuilderResult["error"] };
  remove?: { error: BuilderResult["error"] };
  createSignedUrl?: { data: { signedUrl: string } | null; error: BuilderResult["error"] };
} = {}) {
  return {
    upload: vi.fn(async () => overrides.upload ?? { error: null }),
    remove: vi.fn(async () => overrides.remove ?? { error: null }),
    createSignedUrl: vi.fn(async () => overrides.createSignedUrl ?? { data: { signedUrl: "https://signed.example/x" }, error: null }),
  };
}

/**
 * Builds the full `sb` surface (from/rpc/storage/functions) as a set of
 * queueable vi.fn mocks a test configures per-call via mockReturnValueOnce /
 * mockResolvedValueOnce, mirroring the `AnyClient` shape data.ts casts to.
 */
export function makeSupabaseMock() {
  const from = vi.fn();
  const rpc = vi.fn();
  const invoke = vi.fn();
  const storageFrom = vi.fn();
  return {
    from,
    rpc,
    storage: { from: storageFrom },
    functions: { invoke },
  };
}
