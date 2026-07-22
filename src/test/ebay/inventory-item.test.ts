import { describe, it, expect, vi } from "vitest";
import { fetchInventoryItemForSku, normalizeInventoryItem, type InventoryFetchImpl } from "../../../supabase/functions/_shared/ebay-inventory-item";

const O = "https://api.ebay.com";
const SKU = "GCV000047";
const goodItem = (over: Record<string, unknown> = {}) => ({
  sku: SKU, condition: "LIKE_NEW", conditionDescription: "Gem",
  product: { title: "T", description: "D", aspects: { Grade: ["10"] }, imageUrls: ["https://img/a.jpg", "https://img/b.jpg"] },
  availability: { shipToLocationAvailability: { quantity: 1 } },
  conditionDescriptors: [{ name: "Corners", values: ["A"] }], ...over,
});

describe("normalizeInventoryItem — strict contract", () => {
  it("normalizes a full item (aspects→string[], descriptors→name=values, imageCount, quantity)", () => {
    expect(normalizeInventoryItem(goodItem(), SKU)).toEqual({
      sku: SKU, condition: "LIKE_NEW", conditionDescription: "Gem", conditionDescriptors: ["Corners=A"],
      title: "T", description: "D", aspects: { Grade: ["10"] }, imageCount: 2, quantity: 1,
    });
  });
  it("treats absent optional state honestly (no image list → count 0, absent quantity → null)", () => {
    const it0 = normalizeInventoryItem({ sku: SKU, condition: "USED", product: { title: "T", aspects: {} } }, SKU)!;
    expect(it0.imageCount).toBe(0);
    expect(it0.quantity).toBeNull();
    expect(it0.description).toBe("");
  });
  const bad: Array<[string, Record<string, unknown>]> = [
    ["provider SKU differs", { sku: "GCV000099" }],
    ["product missing", { product: undefined }],
    ["condition missing", { condition: undefined }],
    ["condition non-string", { condition: 5 }],
    ["title missing", { product: { aspects: {} } }],
    ["aspects not object", { product: { title: "T", aspects: "x" } }],
    ["aspect value not string[]", { product: { title: "T", aspects: { Grade: "10" } } }],
    ["imageUrls not array", { product: { title: "T", aspects: {}, imageUrls: "x" } }],
    ["imageUrl not https", { product: { title: "T", aspects: {}, imageUrls: ["http://x"] } }],
    ["quantity fractional", { availability: { shipToLocationAvailability: { quantity: 1.5 } } }],
    ["quantity negative", { availability: { shipToLocationAvailability: { quantity: -1 } } }],
    ["descriptors not array", { conditionDescriptors: "x" }],
    ["descriptor missing name", { conditionDescriptors: [{ values: ["A"] }] }],
  ];
  for (const [name, over] of bad) {
    it(`fails closed (null): ${name}`, () => expect(normalizeInventoryItem(goodItem(over), SKU)).toBeNull());
  }
  it("does NOT fabricate a provider SKU when omitted (uses the requested SKU)", () => {
    const it0 = normalizeInventoryItem({ condition: "USED", product: { title: "T", aspects: {} } }, SKU)!;
    expect(it0.sku).toBe(SKU);
  });
});

const ok200 = (body: unknown): InventoryFetchImpl => async () => ({ ok: true, status: 200, json: async () => body });

describe("fetchInventoryItemForSku — HTTP classification", () => {
  it("present item on 200", async () => {
    const r = await fetchInventoryItemForSku({ fetchImpl: ok200(goodItem()), apiOrigin: O, accessToken: "AT", sku: SKU });
    expect(r).toMatchObject({ ok: true, present: true });
  });
  it("malformed 200 → invalid_provider_response (never a changed-input result)", async () => {
    const r = await fetchInventoryItemForSku({ fetchImpl: ok200({ product: { title: "T", aspects: "bad" }, condition: "USED" }), apiOrigin: O, accessToken: "AT", sku: SKU });
    expect(r).toEqual({ ok: false, errorCode: "invalid_provider_response", httpStatus: 200 });
  });
  it("documented no-item 404 → present:false; arbitrary 404 → lookup_failed", async () => {
    const noItem: InventoryFetchImpl = async () => ({ ok: false, status: 404, json: async () => ({ errors: [{ errorId: 25710 }] }) });
    expect(await fetchInventoryItemForSku({ fetchImpl: noItem, apiOrigin: O, accessToken: "AT", sku: SKU })).toEqual({ ok: true, present: false });
    const other: InventoryFetchImpl = async () => ({ ok: false, status: 404, json: async () => ({ errors: [{ errorId: 99999 }] }) });
    expect(await fetchInventoryItemForSku({ fetchImpl: other, apiOrigin: O, accessToken: "AT", sku: SKU })).toMatchObject({ ok: false, errorCode: "inventory_item_lookup_failed" });
  });
  it("3xx → provider_redirect_rejected", async () => {
    const redir: InventoryFetchImpl = async () => ({ ok: false, status: 302, json: async () => ({}) });
    expect(await fetchInventoryItemForSku({ fetchImpl: redir, apiOrigin: O, accessToken: "AT", sku: SKU })).toMatchObject({ ok: false, errorCode: "provider_redirect_rejected" });
  });
});

describe("fetchInventoryItemForSku — abortable timeout (internal AbortController)", () => {
  it("passes an AbortSignal to the injected fetch and aborts it on timeout", async () => {
    let captured: AbortSignal | undefined;
    const impl: InventoryFetchImpl = (_url, init) => { captured = init.signal as AbortSignal; return new Promise(() => {}); };
    const r = await fetchInventoryItemForSku({ fetchImpl: impl, apiOrigin: O, accessToken: "AT", sku: SKU, timeoutMs: 5 });
    expect(r).toEqual({ ok: false, errorCode: "provider_timeout", httpStatus: null });
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(true);
  });
  it("a LATE resolution after timeout does not change the returned result", async () => {
    let resolveFetch: (v: { ok: boolean; status: number; json: () => Promise<unknown> }) => void = () => {};
    const impl: InventoryFetchImpl = () => new Promise((res) => { resolveFetch = res; });
    const r = await fetchInventoryItemForSku({ fetchImpl: impl, apiOrigin: O, accessToken: "AT", sku: SKU, timeoutMs: 5 });
    expect(r).toMatchObject({ ok: false, errorCode: "provider_timeout" });
    resolveFetch({ ok: true, status: 200, json: async () => goodItem() }); // late — ignored
    await new Promise((res) => setTimeout(res, 10));
    expect(r).toMatchObject({ ok: false, errorCode: "provider_timeout" });
  });
  it("a LATE rejection after timeout does not become an unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onUnhandled);
    let rejectFetch: (e: unknown) => void = () => {};
    const impl: InventoryFetchImpl = () => new Promise((_res, rej) => { rejectFetch = rej; });
    const r = await fetchInventoryItemForSku({ fetchImpl: impl, apiOrigin: O, accessToken: "AT", sku: SKU, timeoutMs: 5 });
    expect(r).toMatchObject({ ok: false, errorCode: "provider_timeout" });
    rejectFetch(new Error("late network error")); // late — must be swallowed
    await new Promise((res) => setTimeout(res, 15));
    process.off("unhandledRejection", onUnhandled);
    expect(seen).toHaveLength(0);
  });
  it("a caller-supplied (already-aborted) signal is classified safely as provider_timeout", async () => {
    const ac = new AbortController(); ac.abort();
    const impl: InventoryFetchImpl = () => new Promise(() => {});
    const r = await fetchInventoryItemForSku({ fetchImpl: impl, apiOrigin: O, accessToken: "AT", sku: SKU, signal: ac.signal, timeoutMs: 10_000 });
    expect(r).toMatchObject({ ok: false, errorCode: "provider_timeout" });
  });
  it("clears its timer on success AND on failure", async () => {
    const spy = vi.spyOn(globalThis, "clearTimeout");
    await fetchInventoryItemForSku({ fetchImpl: ok200(goodItem()), apiOrigin: O, accessToken: "AT", sku: SKU });
    const successCalls = spy.mock.calls.length;
    expect(successCalls).toBeGreaterThan(0);
    const boom: InventoryFetchImpl = async () => { throw new Error("net"); };
    await fetchInventoryItemForSku({ fetchImpl: boom, apiOrigin: O, accessToken: "AT", sku: SKU });
    expect(spy.mock.calls.length).toBeGreaterThan(successCalls);
    spy.mockRestore();
  });
});
