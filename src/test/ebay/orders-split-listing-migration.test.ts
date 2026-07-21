import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/20260818000000_ebay_orders_split_listing_intents.sql"),
  "utf8",
);

const RPCS = ["ebay_orders_persist", "ebay_sales_apply"];

describe("20260818 order-split + listing-intents migration", () => {
  it("drops the combined ebay_orders_apply RPC (persist and apply must never be one op again)", () => {
    expect(SQL).toMatch(/drop function if exists public\.ebay_orders_apply\(uuid, jsonb\)/);
    expect(SQL).not.toMatch(/create or replace function public\.ebay_orders_apply\(/);
  });

  it("both new RPCs are SECURITY DEFINER, service_role-only, with pinned search_path incl. private", () => {
    for (const fn of RPCS) {
      expect(SQL).toContain(`create or replace function public.${fn}(`);
      expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`));
      expect(SQL).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`));
    }
    expect((SQL.match(/set search_path = public, private, pg_temp/g) ?? []).length).toBe(RPCS.length);
  });

  it("ebay_orders_persist writes ONLY the private ledger — never sold_comps or slab inventory", () => {
    const body = SQL.slice(
      SQL.indexOf("create or replace function public.ebay_orders_persist"),
      SQL.indexOf("create or replace function public.ebay_sales_apply"),
    );
    expect(body).toMatch(/insert into private\.ebay_orders/);
    expect(body).toMatch(/insert into private\.ebay_order_line_items/);
    expect(body).not.toMatch(/insert into public\.sold_comps/);
    expect(body).not.toMatch(/update public\.slabs/);
    expect(body).toMatch(/jsonb_build_object\(\s*'orders'[\s\S]*'matched'[\s\S]*'unmatched'/);
  });

  it("ebay_sales_apply reads ALREADY-PERSISTED lines, rejects stale mappings, and applies sold_comps + slab→'sold'", () => {
    const body = SQL.slice(SQL.indexOf("create or replace function public.ebay_sales_apply"));
    // It must READ the persisted line (join orders↔line items), not re-persist.
    expect(body).toMatch(/from private\.ebay_order_line_items li\s+join private\.ebay_orders o/);
    expect(body).not.toMatch(/insert into private\.ebay_order/);
    // Stale-reject on a changed persisted mapping.
    expect(body).toMatch(/v_persisted_slab <> v_slab/);
    // The consequential writes, with the correct lowercase enum.
    expect(body).toMatch(/insert into public\.sold_comps/);
    expect(body).toMatch(/update public\.slabs set inventory_status = 'sold'/);
    expect(body).toMatch(/jsonb_build_object\('applied'[\s\S]*'skipped_stale'[\s\S]*'skipped_unmatched'/);
  });

  it("adds the durable ebay_listing_intents table with admin RLS and one active intent per account+SKU", () => {
    expect(SQL).toMatch(/create table if not exists public\.ebay_listing_intents/);
    expect(SQL).toMatch(/unique \(ebay_account_id, sku\)/);
    expect(SQL).toMatch(/alter table public\.ebay_listing_intents enable row level security/);
    expect(SQL).toMatch(/create policy ebay_listing_intents_admin_all on public\.ebay_listing_intents[\s\S]*is_admin\(auth\.uid\(\)\)/);
    expect(SQL).toMatch(/grant all on public\.ebay_listing_intents to service_role/);
  });
});
