/**
 * Unit coverage for the read-path functions in src/lib/slabs/data.ts (0%
 * covered before this file). Every call is mocked at the Supabase client
 * boundary (see data-mock.ts) so these run without a live database, covering
 * both the success shape and the error-propagation path for each function.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeBuilder } from "./data-mock";

const { supabaseMock } = vi.hoisted(() => ({
  supabaseMock: { from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() }, functions: { invoke: vi.fn() } },
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: supabaseMock }));

import {
  fetchSlabs,
  fetchAllSlabs,
  resolveSlabInventory,
  resolveInventory,
  fetchSlabById,
  fetchAdjacentSlabs,
  fetchComps,
  fetchAllComps,
  fetchPriceChartingOffers,
  fetchFieldEvidence,
  fetchEbayAccounts,
  fetchIntegrationHealth,
} from "@/lib/slabs/data";

beforeEach(() => {
  supabaseMock.from.mockReset();
  supabaseMock.rpc.mockReset();
});

describe("fetchSlabs", () => {
  it("returns rows and total on success, applying search/filter/sort/pagination", async () => {
    const builder = makeBuilder({ data: [{ id: "s1" }], count: 1 });
    supabaseMock.from.mockReturnValue(builder);
    const result = await fetchSlabs({ search: "Charizard", grader: "CGC", minValueCents: 100, maxValueCents: 5000 });
    expect(result).toEqual({ rows: [{ id: "s1" }], total: 1 });
    expect(supabaseMock.from).toHaveBeenCalledWith("slabs");
    expect(builder.or).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("grader", "CGC");
    expect(builder.gte).toHaveBeenCalledWith("final_value_cents", 100);
    expect(builder.lte).toHaveBeenCalledWith("final_value_cents", 5000);
  });

  it("hides archived slabs by default and includes them when requested", async () => {
    const builder = makeBuilder({ data: [], count: 0 });
    supabaseMock.from.mockReturnValue(builder);
    await fetchSlabs({});
    expect(builder.is).toHaveBeenCalledWith("archived_at", null);

    const builder2 = makeBuilder({ data: [], count: 0 });
    supabaseMock.from.mockReturnValue(builder2);
    await fetchSlabs({ includeArchived: true });
    expect(builder2.is).not.toHaveBeenCalled();
  });

  it("throws the raw Supabase error on failure", async () => {
    supabaseMock.from.mockReturnValue(makeBuilder({ error: { message: "boom" } }));
    await expect(fetchSlabs()).rejects.toEqual({ message: "boom" });
  });
});

describe("fetchAllSlabs", () => {
  it("returns all rows ordered by inventory number", async () => {
    const builder = makeBuilder({ data: [{ id: "a" }, { id: "b" }] });
    supabaseMock.from.mockReturnValue(builder);
    const rows = await fetchAllSlabs();
    expect(rows).toEqual([{ id: "a" }, { id: "b" }]);
    expect(builder.order).toHaveBeenCalledWith("inventory_number", { ascending: true });
  });

  it("throws on error", async () => {
    supabaseMock.from.mockReturnValue(makeBuilder({ error: { message: "fail" } }));
    await expect(fetchAllSlabs()).rejects.toEqual({ message: "fail" });
  });
});

describe("resolveSlabInventory / resolveInventory", () => {
  it("resolveSlabInventory calls the ownership-scoped RPC and returns rows", async () => {
    supabaseMock.rpc.mockResolvedValue({ data: [{ id: "s1" }], error: null });
    const rows = await resolveSlabInventory("S0001");
    expect(rows).toEqual([{ id: "s1" }]);
    expect(supabaseMock.rpc).toHaveBeenCalledWith("resolve_slab_inventory", { p_query: "S0001" });
  });

  it("resolveSlabInventory throws on error", async () => {
    supabaseMock.rpc.mockResolvedValue({ data: null, error: { message: "denied" } });
    await expect(resolveSlabInventory("x")).rejects.toEqual({ message: "denied" });
  });

  it("resolveInventory returns [] when the RPC has no data", async () => {
    supabaseMock.rpc.mockResolvedValue({ data: null, error: null });
    const rows = await resolveInventory("free text");
    expect(rows).toEqual([]);
  });
});

describe("fetchSlabById", () => {
  it("returns the slab when found", async () => {
    supabaseMock.from.mockReturnValue(makeBuilder({ data: { id: "s1" } }));
    const slab = await fetchSlabById("s1");
    expect(slab).toEqual({ id: "s1" });
  });

  it("returns null when not found", async () => {
    supabaseMock.from.mockReturnValue(makeBuilder({ data: null }));
    expect(await fetchSlabById("missing")).toBeNull();
  });

  it("throws on error", async () => {
    supabaseMock.from.mockReturnValue(makeBuilder({ error: { message: "rls denied" } }));
    await expect(fetchSlabById("s1")).rejects.toEqual({ message: "rls denied" });
  });
});

describe("fetchAdjacentSlabs", () => {
  it("resolves prev and next independently", async () => {
    const prevBuilder = makeBuilder({ data: { id: "prev", inventory_number: 31 } });
    const nextBuilder = makeBuilder({ data: { id: "next", inventory_number: 33 } });
    supabaseMock.from.mockReturnValueOnce(prevBuilder).mockReturnValueOnce(nextBuilder);
    const result = await fetchAdjacentSlabs(32);
    expect(result.prev).toEqual({ id: "prev", inventory_number: 31 });
    expect(result.next).toEqual({ id: "next", inventory_number: 33 });
  });

  it("returns nulls when there is no neighbor on either side", async () => {
    supabaseMock.from.mockReturnValueOnce(makeBuilder({ data: null })).mockReturnValueOnce(makeBuilder({ data: null }));
    const result = await fetchAdjacentSlabs(1);
    expect(result).toEqual({ prev: null, next: null });
  });
});

describe("fetchComps / fetchAllComps", () => {
  it("fetchComps scopes to the slab and orders by sale_date desc", async () => {
    const builder = makeBuilder({ data: [{ id: "c1" }] });
    supabaseMock.from.mockReturnValue(builder);
    const rows = await fetchComps("s1");
    expect(rows).toEqual([{ id: "c1" }]);
    expect(builder.eq).toHaveBeenCalledWith("slab_id", "s1");
  });

  it("fetchComps throws on error", async () => {
    supabaseMock.from.mockReturnValue(makeBuilder({ error: { message: "fail" } }));
    await expect(fetchComps("s1")).rejects.toEqual({ message: "fail" });
  });

  it("fetchAllComps returns [] when no rows", async () => {
    supabaseMock.from.mockReturnValue(makeBuilder({ data: null }));
    expect(await fetchAllComps()).toEqual([]);
  });
});

describe("fetchPriceChartingOffers", () => {
  it("returns offers for the slab", async () => {
    supabaseMock.from.mockReturnValue(makeBuilder({ data: [{ offer_id: "o1" }] }));
    expect(await fetchPriceChartingOffers("s1")).toEqual([{ offer_id: "o1" }]);
  });

  it("throws on error", async () => {
    supabaseMock.from.mockReturnValue(makeBuilder({ error: { message: "denied" } }));
    await expect(fetchPriceChartingOffers("s1")).rejects.toEqual({ message: "denied" });
  });
});

describe("fetchFieldEvidence", () => {
  it("returns evidence rows for the slab", async () => {
    supabaseMock.from.mockReturnValue(makeBuilder({ data: [{ id: "e1", field_name: "card_name" }] }));
    expect(await fetchFieldEvidence("s1")).toEqual([{ id: "e1", field_name: "card_name" }]);
  });

  it("throws on error", async () => {
    supabaseMock.from.mockReturnValue(makeBuilder({ error: { message: "fail" } }));
    await expect(fetchFieldEvidence("s1")).rejects.toEqual({ message: "fail" });
  });
});

describe("fetchEbayAccounts", () => {
  it("returns [] when no rows are returned", async () => {
    supabaseMock.from.mockReturnValue(makeBuilder({ data: null }));
    expect(await fetchEbayAccounts()).toEqual([]);
  });

  it("throws on error", async () => {
    supabaseMock.from.mockReturnValue(makeBuilder({ error: { message: "fail" } }));
    await expect(fetchEbayAccounts()).rejects.toEqual({ message: "fail" });
  });
});

describe("fetchIntegrationHealth", () => {
  it("combines both counts, defaulting missing counts to 0", async () => {
    supabaseMock.from
      .mockReturnValueOnce(makeBuilder({ count: 3 }))
      .mockReturnValueOnce(makeBuilder({ count: null }));
    expect(await fetchIntegrationHealth()).toEqual({ failed_sync_jobs: 3, unresolved_errors: 0 });
  });
});
