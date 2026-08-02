/**
 * Unit coverage for the mutation / archive / delete path in
 * src/lib/slabs/data.ts: updateSlab, comp CRUD, archive/unarchive/hard-delete,
 * and signedImageUrl. Mocked at the Supabase client boundary.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeBuilder } from "./data-mock";

const { supabaseMock } = vi.hoisted(() => ({
  supabaseMock: { from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() }, functions: { invoke: vi.fn() } },
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: supabaseMock }));

import {
  updateSlab,
  insertComp,
  updateComp,
  deleteComp,
  archiveSlab,
  unarchiveSlab,
  hardDeleteSlab,
  signedImageUrl,
} from "@/lib/slabs/data";

beforeEach(() => {
  supabaseMock.from.mockReset();
  supabaseMock.rpc.mockReset();
  supabaseMock.storage.from.mockReset();
});

describe("updateSlab", () => {
  it("patches the slab and returns the updated row", async () => {
    const builder = makeBuilder({ data: { id: "s1", card_name: "Charmander" } });
    supabaseMock.from.mockReturnValue(builder);
    const result = await updateSlab("s1", { card_name: "Charmander" });
    expect(result).toEqual({ id: "s1", card_name: "Charmander" });
    expect(builder.update).toHaveBeenCalledWith({ card_name: "Charmander" });
    expect(builder.eq).toHaveBeenCalledWith("id", "s1");
  });

  it("throws on error", async () => {
    supabaseMock.from.mockReturnValue(makeBuilder({ error: { message: "constraint" } }));
    await expect(updateSlab("s1", {})).rejects.toEqual({ message: "constraint" });
  });
});

describe("comp CRUD", () => {
  it("insertComp attaches slab_id and returns the created row", async () => {
    const builder = makeBuilder({ data: { id: "c1" } });
    supabaseMock.from.mockReturnValue(builder);
    const result = await insertComp("s1", { sale_date: "2026-01-01" } as never);
    expect(result).toEqual({ id: "c1" });
    expect(builder.insert).toHaveBeenCalledWith(expect.objectContaining({ slab_id: "s1" }));
  });

  it("insertComp throws on error", async () => {
    supabaseMock.from.mockReturnValue(makeBuilder({ error: { message: "fail" } }));
    await expect(insertComp("s1", {} as never)).rejects.toEqual({ message: "fail" });
  });

  it("updateComp patches by id", async () => {
    supabaseMock.from.mockReturnValue(makeBuilder({ data: { id: "c1", notes: "x" } }));
    expect(await updateComp("c1", { notes: "x" } as never)).toEqual({ id: "c1", notes: "x" });
  });

  it("deleteComp resolves with no error", async () => {
    supabaseMock.from.mockReturnValue(makeBuilder({ error: null }));
    await expect(deleteComp("c1")).resolves.toBeUndefined();
  });

  it("deleteComp throws on error", async () => {
    supabaseMock.from.mockReturnValue(makeBuilder({ error: { message: "fail" } }));
    await expect(deleteComp("c1")).rejects.toEqual({ message: "fail" });
  });
});

describe("archive / unarchive / hard delete", () => {
  it("archiveSlab unwraps an array RPC result", async () => {
    supabaseMock.rpc.mockResolvedValue({ data: [{ id: "s1", archived_at: "now" }], error: null });
    expect(await archiveSlab("s1")).toEqual({ id: "s1", archived_at: "now" });
    expect(supabaseMock.rpc).toHaveBeenCalledWith("archive_slab", { p_id: "s1" });
  });

  it("archiveSlab throws on error", async () => {
    supabaseMock.rpc.mockResolvedValue({ data: null, error: { message: "fail" } });
    await expect(archiveSlab("s1")).rejects.toEqual({ message: "fail" });
  });

  it("unarchiveSlab unwraps an object RPC result", async () => {
    supabaseMock.rpc.mockResolvedValue({ data: { id: "s1", archived_at: null }, error: null });
    expect(await unarchiveSlab("s1")).toEqual({ id: "s1", archived_at: null });
  });

  it("hardDeleteSlab removes images and reports success", async () => {
    supabaseMock.rpc.mockResolvedValue({
      data: [{ front_image_path: "slabs/1/front.jpg", back_image_path: "slabs/1/back.jpg" }],
      error: null,
    });
    const removeMock = vi.fn(async () => ({ error: null }));
    supabaseMock.storage.from.mockReturnValue({ remove: removeMock });
    const report = await hardDeleteSlab("s1");
    expect(report.row_deleted).toBe(true);
    expect(report.images_removed).toEqual(["slabs/1/front.jpg", "slabs/1/back.jpg"]);
    expect(report.image_errors).toEqual([]);
    expect(removeMock).toHaveBeenCalledWith(["slabs/1/front.jpg", "slabs/1/back.jpg"]);
  });

  it("hardDeleteSlab reports a partial-cleanup failure instead of hiding it", async () => {
    supabaseMock.rpc.mockResolvedValue({ data: [{ front_image_path: "slabs/1/front.jpg", back_image_path: null }], error: null });
    supabaseMock.storage.from.mockReturnValue({ remove: vi.fn(async () => ({ error: { message: "storage down" } })) });
    const report = await hardDeleteSlab("s1");
    expect(report.images_removed).toEqual([]);
    expect(report.image_errors).toEqual(["storage down"]);
  });

  it("hardDeleteSlab throws when the RPC itself fails (nothing deleted)", async () => {
    supabaseMock.rpc.mockResolvedValue({ data: null, error: { message: "not found" } });
    await expect(hardDeleteSlab("missing")).rejects.toEqual({ message: "not found" });
  });
});

describe("signedImageUrl", () => {
  it("returns null for a null path without calling storage", async () => {
    expect(await signedImageUrl(null)).toBeNull();
    expect(supabaseMock.storage.from).not.toHaveBeenCalled();
  });

  it("returns the signed URL on success", async () => {
    supabaseMock.storage.from.mockReturnValue({
      createSignedUrl: vi.fn(async () => ({ data: { signedUrl: "https://signed.example/img" }, error: null })),
    });
    expect(await signedImageUrl("slabs/1/front.jpg")).toBe("https://signed.example/img");
  });

  it("returns null (not a throw) when signing fails", async () => {
    supabaseMock.storage.from.mockReturnValue({
      createSignedUrl: vi.fn(async () => ({ data: null, error: { message: "not found" } })),
    });
    expect(await signedImageUrl("missing.jpg")).toBeNull();
  });
});
