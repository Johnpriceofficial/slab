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
  const inv = 900_000_000 + (Math.floor(performance.now()) % 90_000_000);
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

    const { data: slab, error: sErr } = await service.from("slabs").insert({ inventory_number: inv, card_name: "PR B Test", certification_number: `PRB-${stamp}`, inventory_status: "active" }).select("id").single();
    if (sErr) throw sErr;
    slabId = slab!.id;
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

  it("orders_apply records the ledger, writes ONE sold comp, and marks the mapped slab sold", async () => {
    const res = await service.rpc("ebay_orders_apply", { p_account_id: accountId, p_orders: shapedOrders() });
    expect(res.error).toBeNull();
    // 1 order, 2 line items, but only the mapped+priced line is a sale.
    expect(res.data).toEqual({ orders: 1, line_items: 2, sales_applied: 1 });

    const comps = await service.from("sold_comps").select("slab_id, source, sold_price_cents, currency").eq("external_sale_id", extId);
    expect(comps.data).toHaveLength(1);
    expect(comps.data![0]).toMatchObject({ slab_id: slabId, source: "EBAY_SELLER_ORDER", sold_price_cents: 1800, currency: "USD" });
    // The unmapped line created NO sold comp.
    const unmapped = await service.from("sold_comps").select("id").eq("external_sale_id", `ORD-PRB-${stamp}:LI-2`);
    expect(unmapped.data).toHaveLength(0);

    const slab = await service.from("slabs").select("inventory_status, sold_price_cents").eq("id", slabId).single();
    expect(slab.data).toMatchObject({ inventory_status: "sold", sold_price_cents: 1800 });
  });

  it("is idempotent — a second identical apply does not duplicate the sold comp", async () => {
    const res = await service.rpc("ebay_orders_apply", { p_account_id: accountId, p_orders: shapedOrders() });
    expect(res.data).toEqual({ orders: 1, line_items: 2, sales_applied: 1 });
    const comps = await service.from("sold_comps").select("id").eq("external_sale_id", extId);
    expect(comps.data).toHaveLength(1); // still one, not two
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

  it("denies both apply RPCs to the authenticated (non-service) role", async () => {
    expect((await adminClient.rpc("ebay_orders_apply", { p_account_id: accountId, p_orders: [] })).error).not.toBeNull();
    expect((await adminClient.rpc("ebay_finance_transactions_apply", { p_account_id: accountId, p_transactions: [] })).error).not.toBeNull();
  });
});
