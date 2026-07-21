import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/20260817000000_ebay_orders_finances_rpcs.sql"),
  "utf8",
);

const RPCS = ["ebay_orders_apply", "ebay_finance_transactions_apply"];

describe("20260817 eBay orders/finances RPC migration", () => {
  it("defines both RPCs as SECURITY DEFINER, service_role-only, with a pinned search_path incl. private", () => {
    expect((SQL.match(/security definer/g) ?? []).length).toBe(RPCS.length);
    for (const fn of RPCS) {
      expect(SQL).toContain(`create or replace function public.${fn}(`);
      expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`));
      expect(SQL).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`));
    }
    // Both need `private` in the search_path to reach the ledger tables.
    expect((SQL.match(/set search_path = public, private, pg_temp/g) ?? []).length).toBe(RPCS.length);
    expect(SQL).not.toMatch(/grant execute on function public\.ebay_[^;]*to (anon|authenticated)/);
  });

  it("orders_apply writes the private ledger AND applies sales atomically in one function", () => {
    const body = SQL.slice(
      SQL.indexOf("create or replace function public.ebay_orders_apply"),
      SQL.indexOf("create or replace function public.ebay_finance_transactions_apply"),
    );
    expect(body).toMatch(/insert into private\.ebay_orders/);
    expect(body).toMatch(/insert into private\.ebay_order_line_items/);
    expect(body).toMatch(/insert into public\.sold_comps/);
    // Inventory status must be the lowercase enum the check constraint allows.
    expect(body).toMatch(/update public\.slabs\s+set inventory_status = 'sold'/);
    expect(body).not.toMatch(/inventory_status = 'Sold'/);
    // Sales apply ONLY to mapped line items that carry a real sold amount.
    expect(body).toMatch(/if v_slab is not null and v_cents is not null then/);
    // Returns confirmed counts.
    expect(body).toMatch(/jsonb_build_object\(\s*'orders'/);
  });

  it("both apply RPCs upsert idempotently (repeat syncs converge, never duplicate)", () => {
    expect(SQL).toMatch(/on conflict \(ebay_account_id, order_id\) do update/);
    expect(SQL).toMatch(/on conflict \(order_id, line_item_id\) do update/);
    expect(SQL).toMatch(/on conflict \(source, external_sale_id\) do update/);
    expect(SQL).toMatch(/on conflict \(ebay_account_id, transaction_id\) do update/);
  });

  it("finance apply returns a confirmed transaction count", () => {
    const body = SQL.slice(SQL.indexOf("ebay_finance_transactions_apply"));
    expect(body).toMatch(/insert into private\.ebay_financial_transactions/);
    expect(body).toMatch(/jsonb_build_object\('transactions'/);
  });
});
