import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Behavioral coverage for 20260817000000_ebay_orders_finances_rpcs.sql against the
// disposable CI Supabase. Proves: ebay_orders_apply records the private ledger AND
// applies sales (sold_comps + slab→sold) transactionally and idempotently, marks
// ONLY mapped+priced lines, and is service_role-only; ebay_finance_transactions_apply
// upserts idempotently with a confirmed post-write total.
const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("eBay orders/finances apply RPCs", () => {
  let service: SupabaseClient;
  let adminClient: SupabaseClient;
  const stamp = `${Math.floor(performance.now())}`;
  const userIds: string[] = [];
  const accountIds: string[] = [];
  let accountId = "";
  let slabId = "";
  const mappedSku = `GCV-PRB-${stamp}`;
  const extId = `ORD-PRB-${stamp}:LI-1`;

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `ebof-svc-${stamp}` } });
    const email = `ebay-of+${stamp}@slabvault.test`;
    const password = `Test-ebof-${stamp}`;
    const { data: u, error: uErr } = await service.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { graded_card_value_admin: true } });
    if (uErr) throw uErr;
    userIds.push(u.user!.id);
    await service.from("slab_admins").insert({ user_id: u.user!.id });
    adminClient = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `ebof-admin-${stamp}` } });
    await adminClient.auth.signInWithPassword({ email, password });

    const { data: acct, error: aErr } = await service.from("ebay_accounts").insert({ ebay_user_id: `ebay-of-${stamp}`, connection_status: "connected" }).select("id").single();
    if (aErr) throw aErr;
    accountId = acct!.id;
    accountIds.push(accountId);

    // create_slab (SECURITY DEFINER) sets the NOT NULL columns + allocates the
    // inventory number; it must run as the signed-in admin and needs a front image.
    const { data: slab, error: sErr } = await adminClient.rpc("create_slab", {
      p: { card_name: "PR B Test", grader: "PSA", grade: "9", certification_number: `PRB-${stamp}`, verification_status: "verified", valuation_confidence: "manual" },
      p_front_ext: "jpg",
      p_back_ext: null,
    });
    if (sErr) throw sErr;
    slabId = (slab as { id: string }).id;
    await service.from("ebay_listing_mappings").insert({ slab_id: slabId, ebay_account_id: accountId, sku: mappedSku, listing_status: "published" });
  });

  afterAll(async () => {
    await service.from("sold_comps").delete().eq("external_sale_id", extId);
    for (const id of accountIds) await service.from("ebay_accounts").delete().eq("id", id);
    if (slabId) await service.from("slabs").delete().eq("id", slabId);
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  const shapedOrders = () => [{
    order_id: `ORD-PRB-${stamp}`,
    order_status: "FULFILLED",
    buyer_data: { buyer: { username: "prb-buyer" } },
    pricing_summary: { total: { value: "20.00", currency: "USD" } },
    raw_response: { orderId: `ORD-PRB-${stamp}` },
    line_items: [
      { line_item_id: "LI-1", slab_id: slabId, sku: mappedSku, listing_id: "111", quantity: 1, line_total: { value: "18.00", currency: "USD" }, raw_response: { lineItemId: "LI-1" }, sold_price_cents: 1800, currency: "USD", sold_at: "2026-07-20T10:00:00.000Z", external_sale_id: extId },
      { line_item_id: "LI-2", slab_id: null, sku: "UNMAPPED", listing_id: null, quantity: 1, line_total: { value: "2.00", currency: "USD" }, raw_response: { lineItemId: "LI-2" }, sold_price_cents: 200, currency: "USD", sold_at: "2026-07-20T10:00:00.000Z", external_sale_id: `ORD-PRB-${stamp}:LI-2` },
    ],
  }];

  const salesSelection = (slabOverride?: string | null) => [{
    order_id: `ORD-PRB-${stamp}`, line_item_id: "LI-1",
    slab_id: slabOverride === undefined ? slabId : slabOverride,
    sold_price_cents: 1800, currency: "USD", sold_at: "2026-07-20T10:00:00.000Z", external_sale_id: extId,
  }];

  it("orders_persist records orders + lines and marks NOTHING sold (non-destructive)", async () => {
    const res = await service.rpc("ebay_orders_persist", { p_account_id: accountId, p_orders: shapedOrders() });
    expect(res.error).toBeNull();
    // 1 order, 2 lines, 1 matched (mapped SKU), 1 unmatched.
    // C.8.1: ebay_orders_persist now ALSO returns confirmed durable totals read
    // back from the private tables (idempotent under retries + overlap).
    expect(res.data).toMatchObject({ orders: 1, line_items: 2, matched: 1, unmatched: 1 });
    expect((res.data as { confirmed_order_total: number }).confirmed_order_total).toBe(1);
    expect((res.data as { confirmed_line_total: number }).confirmed_line_total).toBe(2);

    // Persisting an order must NOT create a sold comp or touch inventory.
    const comps = await service.from("sold_comps").select("id").eq("external_sale_id", extId);
    expect(comps.data).toHaveLength(0);
    const slab = await service.from("slabs").select("inventory_status, sold_price_cents").eq("id", slabId).single();
    expect(slab.data).toMatchObject({ inventory_status: "active", sold_price_cents: null });
  });

  it("sales_apply acts ONLY on persisted, matching lines — writes one comp + marks the slab sold, idempotently", async () => {
    const first = await service.rpc("ebay_sales_apply", { p_account_id: accountId, p_sales: salesSelection() });
    expect(first.error).toBeNull();
    expect(first.data).toEqual({ applied: 1, skipped_stale: 0, skipped_unmatched: 0 });

    const comps = await service.from("sold_comps").select("slab_id, source, sold_price_cents").eq("external_sale_id", extId);
    expect(comps.data).toHaveLength(1);
    expect(comps.data![0]).toMatchObject({ slab_id: slabId, source: "EBAY_SELLER_ORDER", sold_price_cents: 1800 });
    const slab = await service.from("slabs").select("inventory_status, sold_price_cents").eq("id", slabId).single();
    expect(slab.data).toMatchObject({ inventory_status: "sold", sold_price_cents: 1800 });

    // Idempotent: reapplying does not duplicate the comp.
    const second = await service.rpc("ebay_sales_apply", { p_account_id: accountId, p_sales: salesSelection() });
    expect(second.data).toEqual({ applied: 1, skipped_stale: 0, skipped_unmatched: 0 });
    const still = await service.from("sold_comps").select("id").eq("external_sale_id", extId);
    expect(still.data).toHaveLength(1);
  });

  it("sales_apply rejects a stale selection (slab mapping changed) and an unpersisted line", async () => {
    // Stale: the audited slab_id no longer matches the persisted line's slab.
    const stale = await service.rpc("ebay_sales_apply", { p_account_id: accountId, p_sales: salesSelection("00000000-0000-0000-0000-000000000000") });
    expect(stale.data).toEqual({ applied: 0, skipped_stale: 1, skipped_unmatched: 0 });
    // Unmatched: a line that was never persisted.
    const unmatched = await service.rpc("ebay_sales_apply", { p_account_id: accountId, p_sales: [{ order_id: `ORD-PRB-${stamp}`, line_item_id: "DOES-NOT-EXIST", slab_id: slabId, sold_price_cents: 1800, external_sale_id: "x" }] });
    expect(unmatched.data).toEqual({ applied: 0, skipped_stale: 0, skipped_unmatched: 1 });
  });

  it("a durable listing intent is admin-visible and unique per account+SKU", async () => {
    const ins = await service.from("ebay_listing_intents").insert({ ebay_account_id: accountId, slab_id: slabId, sku: mappedSku, status: "preparing" });
    expect(ins.error).toBeNull();
    // One active intent per (account, sku): a duplicate insert is rejected.
    const dup = await service.from("ebay_listing_intents").insert({ ebay_account_id: accountId, slab_id: slabId, sku: mappedSku, status: "preparing" });
    expect(dup.error).not.toBeNull();
    // The signed-in admin can read intents.
    const seen = await adminClient.from("ebay_listing_intents").select("sku, status").eq("ebay_account_id", accountId);
    expect(seen.error).toBeNull();
    expect(seen.data?.some((r) => r.sku === mappedSku)).toBe(true);
  });

  it("finance_transactions_apply upserts idempotently and returns a confirmed total", async () => {
    const txns = [
      { transaction_id: `TX-A-${stamp}`, order_id: `ORD-PRB-${stamp}`, transaction_type: "SALE", transaction_status: "FUNDS_AVAILABLE", amount: { value: "18.00", currency: "USD" }, fee_basis_amount: { value: "18.00" }, raw_response: { transactionId: `TX-A-${stamp}` }, occurred_at: "2026-07-20T11:00:00.000Z" },
      { transaction_id: `TX-B-${stamp}`, order_id: null, transaction_type: "SHIPPING_LABEL", transaction_status: "FUNDS_AVAILABLE", amount: { value: "-3.00", currency: "USD" }, fee_basis_amount: null, raw_response: { transactionId: `TX-B-${stamp}` }, occurred_at: null },
    ];
    const first = await service.rpc("ebay_finance_transactions_apply", { p_account_id: accountId, p_transactions: txns });
    expect(first.error).toBeNull();
    expect(first.data).toEqual({ transactions: 2, total: 2 });
    // Re-applying the same two converges: confirmed total stays 2, not 4.
    const second = await service.rpc("ebay_finance_transactions_apply", { p_account_id: accountId, p_transactions: txns });
    expect(second.data).toEqual({ transactions: 2, total: 2 });
  });

  it("denies the persistence RPCs to the authenticated (non-service) role", async () => {
    expect((await adminClient.rpc("ebay_orders_persist", { p_account_id: accountId, p_orders: [] })).error).not.toBeNull();
    expect((await adminClient.rpc("ebay_sales_apply", { p_account_id: accountId, p_sales: [] })).error).not.toBeNull();
    expect((await adminClient.rpc("ebay_finance_transactions_apply", { p_account_id: accountId, p_transactions: [] })).error).not.toBeNull();
  });
});
