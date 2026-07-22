/**
 * Unit coverage for `supabaseSlabDataAccess` — the production SlabDataAccess
 * implementation used by the intake save flow (src/lib/slabs/data.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeBuilder } from "./data-mock";

const { supabaseMock } = vi.hoisted(() => ({
  supabaseMock: { from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() }, functions: { invoke: vi.fn() } },
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: supabaseMock }));

// createImageBitmap doesn't exist in jsdom; registerImageEvidence falls back
// to { width: null, height: null } on failure, which is the path we exercise.
function makeFakeBlob(): Blob {
  return { arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Blob;
}

describe("supabaseSlabDataAccess", () => {
  beforeEach(() => {
    supabaseMock.from.mockReset();
    supabaseMock.rpc.mockReset();
    supabaseMock.storage.from.mockReset();
    // registerImageEvidence hashes the blob via crypto.subtle.digest; stub it
    // so these tests exercise the DB round-trip/error-mapping logic, not the
    // browser Web Crypto implementation (already exercised by real usage).
    vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
  });

  it("checkCertification returns null when the RPC finds no duplicate", async () => {
    const { supabaseSlabDataAccess } = await import("@/lib/slabs/data");
    supabaseMock.rpc.mockResolvedValue({ data: [], error: null });
    expect(await supabaseSlabDataAccess.checkCertification("CGC", "000047")).toBeNull();
  });

  it("checkCertification returns the existing slab identity when found", async () => {
    const { supabaseSlabDataAccess } = await import("@/lib/slabs/data");
    supabaseMock.rpc.mockResolvedValue({ data: [{ id: "s1", inventory_number: 7 }], error: null });
    expect(await supabaseSlabDataAccess.checkCertification("CGC", "000047")).toEqual({ id: "s1", inventory_number: 7 });
    expect(supabaseMock.rpc).toHaveBeenCalledWith("check_slab_certification", { p_grader: "CGC", p_cert: "000047" });
  });

  it("checkCertification returns null on RPC error rather than throwing", async () => {
    const { supabaseSlabDataAccess } = await import("@/lib/slabs/data");
    supabaseMock.rpc.mockResolvedValue({ data: null, error: { message: "fail" } });
    expect(await supabaseSlabDataAccess.checkCertification("CGC", "1")).toBeNull();
  });

  it("createSlabRow maps a duplicate-certification error to a structured code", async () => {
    const { supabaseSlabDataAccess } = await import("@/lib/slabs/data");
    supabaseMock.rpc.mockResolvedValue({
      data: null,
      error: { code: "23505", message: "duplicate", details: "already exists as 42" },
    });
    const result = await supabaseSlabDataAccess.createSlabRow({} as never, "jpg", null);
    expect(result.data).toBeNull();
    expect(result.error).toEqual({
      code: "DUPLICATE_CERTIFICATION",
      message: "Duplicate certification number.",
      existing_inventory_number: 42,
    });
  });

  it("createSlabRow maps a permission error to NOT_AUTHORIZED", async () => {
    const { supabaseSlabDataAccess } = await import("@/lib/slabs/data");
    supabaseMock.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "denied" } });
    const result = await supabaseSlabDataAccess.createSlabRow({} as never, "jpg", null);
    expect(result.error).toEqual({ code: "NOT_AUTHORIZED", message: "You do not have permission to add slabs." });
  });

  it("createSlabRow unwraps a single composite row on success", async () => {
    const { supabaseSlabDataAccess } = await import("@/lib/slabs/data");
    supabaseMock.rpc.mockResolvedValue({ data: [{ id: "s1", inventory_number: 1 }], error: null });
    const result = await supabaseSlabDataAccess.createSlabRow({} as never, "jpg", "jpg");
    expect(result).toEqual({ data: { id: "s1", inventory_number: 1 }, error: null });
  });

  it("uploadImage returns a structured error on storage failure", async () => {
    const { supabaseSlabDataAccess } = await import("@/lib/slabs/data");
    supabaseMock.storage.from.mockReturnValue({ upload: vi.fn(async () => ({ error: { message: "quota exceeded" } })) });
    const result = await supabaseSlabDataAccess.uploadImage("slabs/1/front.jpg", new Blob());
    expect(result).toEqual({ error: { message: "quota exceeded" } });
  });

  it("uploadImage succeeds with no error", async () => {
    const { supabaseSlabDataAccess } = await import("@/lib/slabs/data");
    supabaseMock.storage.from.mockReturnValue({ upload: vi.fn(async () => ({ error: null })) });
    expect(await supabaseSlabDataAccess.uploadImage("slabs/1/front.jpg", new Blob())).toEqual({ error: null });
  });

  it("deleteImages is a no-op for an empty path list", async () => {
    const { supabaseSlabDataAccess } = await import("@/lib/slabs/data");
    await supabaseSlabDataAccess.deleteImages([]);
    expect(supabaseMock.storage.from).not.toHaveBeenCalled();
  });

  it("deleteImages throws a descriptive error when storage removal fails", async () => {
    const { supabaseSlabDataAccess } = await import("@/lib/slabs/data");
    supabaseMock.storage.from.mockReturnValue({ remove: vi.fn(async () => ({ error: { message: "down" } })) });
    await expect(supabaseSlabDataAccess.deleteImages(["a.jpg", "b.jpg"])).rejects.toThrow(/Image cleanup failed for a.jpg, b.jpg: down/);
  });

  it("deleteSlabRow throws a descriptive error on failure", async () => {
    const { supabaseSlabDataAccess } = await import("@/lib/slabs/data");
    supabaseMock.from.mockReturnValue(makeBuilder({ error: { message: "fk violation" } }));
    await expect(supabaseSlabDataAccess.deleteSlabRow("s1")).rejects.toThrow(/Slab-row cleanup failed for s1: fk violation/);
  });

  it("deleteSlabRow resolves on success", async () => {
    const { supabaseSlabDataAccess } = await import("@/lib/slabs/data");
    supabaseMock.from.mockReturnValue(makeBuilder({ error: null }));
    await expect(supabaseSlabDataAccess.deleteSlabRow("s1")).resolves.toBeUndefined();
  });

  it("applySlabPricing returns true when the stale-write guard accepts the write", async () => {
    const { supabaseSlabDataAccess } = await import("@/lib/slabs/data");
    supabaseMock.rpc.mockResolvedValue({ data: true, error: null });
    const applied = await supabaseSlabDataAccess.applySlabPricing!("s1", {
      persist: { source: "PriceCharting", retrieved_at: "2026-01-01T00:00:00Z", tiers: [] },
    });
    expect(applied).toBe(true);
  });

  it("applySlabPricing returns false when stale-rejected", async () => {
    const { supabaseSlabDataAccess } = await import("@/lib/slabs/data");
    supabaseMock.rpc.mockResolvedValue({ data: false, error: null });
    const applied = await supabaseSlabDataAccess.applySlabPricing!("s1", {
      persist: { source: "PriceCharting", retrieved_at: "2026-01-01T00:00:00Z", tiers: [] },
    });
    expect(applied).toBe(false);
  });

  it("applySlabPricing throws on RPC error", async () => {
    const { supabaseSlabDataAccess } = await import("@/lib/slabs/data");
    supabaseMock.rpc.mockResolvedValue({ data: null, error: { message: "constraint" } });
    await expect(
      supabaseSlabDataAccess.applySlabPricing!("s1", {
        persist: { source: "PriceCharting", retrieved_at: "2026-01-01T00:00:00Z", tiers: [] },
      }),
    ).rejects.toThrow("constraint");
  });

  it("registerImageEvidence throws when the original image row cannot be registered", async () => {
    const { supabaseSlabDataAccess } = await import("@/lib/slabs/data");
    supabaseMock.from.mockReturnValue(makeBuilder({ error: { message: "insert failed" } }));
    await expect(
      supabaseSlabDataAccess.registerImageEvidence!(
        "s1",
        "front",
        { path: "slabs/1/front.jpg", blob: makeFakeBlob(), mime: "image/jpeg" },
        { path: "slabs/1/front.jpg", blob: makeFakeBlob(), mime: "image/jpeg" },
      ),
    ).rejects.toThrow(/Original front evidence could not be registered: insert failed/);
  });

  it("registerImageEvidence succeeds when original and normalized paths are identical (no derivative needed)", async () => {
    const { supabaseSlabDataAccess } = await import("@/lib/slabs/data");
    supabaseMock.from.mockReturnValue(makeBuilder({ data: { id: "img1" }, error: null }));
    await expect(
      supabaseSlabDataAccess.registerImageEvidence!(
        "s1",
        "front",
        { path: "slabs/1/front.jpg", blob: makeFakeBlob(), mime: "image/jpeg" },
        { path: "slabs/1/front.jpg", blob: makeFakeBlob(), mime: "image/jpeg" },
      ),
    ).resolves.toBeUndefined();
  });
});
