-- ============================================================================
-- PR C.3: separate order persistence from sale application, and add a durable
-- listing-intent lifecycle.
--
--  * ebay_orders_persist — NON-DESTRUCTIVE inbound order sync. Persists private
--    orders + line items only. It never creates sold_comps and never mutates
--    slab inventory. Idempotent; returns confirmed persisted + matched/unmatched
--    counts. This is what the normal "Sync orders" action calls.
--  * ebay_sales_apply — the SEPARATE consequential local-inventory action. It
--    operates ONLY on ALREADY-PERSISTED order lines (it never re-fetches or
--    re-persists provider orders), applies sold_comps + slab→'sold' idempotently
--    for the caller's SELECTED lines, and REJECTS stale selections: a line whose
--    persisted slab mapping no longer matches the audited selection is skipped.
--  * ebay_orders_apply (the old combined RPC) is DROPPED — recording orders and
--    moving inventory must never be one operation again.
--  * ebay_listing_intents — a durable local record of an in-flight/published
--    eBay listing so a live listing is never orphaned when local persistence
--    fails (published_unmapped) and repeat publishes reconcile instead of
--    duplicating offers.
-- ============================================================================

-- The combined persist+apply RPC is replaced by the two below.
drop function if exists public.ebay_orders_apply(uuid, jsonb);

-- ── Non-destructive order persistence ───────────────────────────────────────
create or replace function public.ebay_orders_persist(p_account_id uuid, p_orders jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_order jsonb;
  v_li jsonb;
  v_order_uuid uuid;
  v_slab uuid;
  v_orders int := 0;
  v_lines int := 0;
  v_matched int := 0;
  v_unmatched int := 0;
begin
  for v_order in select value from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb)) loop
    if coalesce(v_order->>'order_id', '') = '' then continue; end if;
    insert into private.ebay_orders (ebay_account_id, order_id, order_status, buyer_data, pricing_summary, raw_response, updated_at)
    values (p_account_id, v_order->>'order_id', v_order->>'order_status', v_order->'buyer_data', v_order->'pricing_summary', coalesce(v_order->'raw_response', '{}'::jsonb), now())
    on conflict (ebay_account_id, order_id) do update
      set order_status = excluded.order_status, buyer_data = excluded.buyer_data,
          pricing_summary = excluded.pricing_summary, raw_response = excluded.raw_response, updated_at = now()
    returning id into v_order_uuid;
    v_orders := v_orders + 1;

    for v_li in select value from jsonb_array_elements(coalesce(v_order->'line_items', '[]'::jsonb)) loop
      if coalesce(v_li->>'line_item_id', '') = '' then continue; end if;
      v_slab := nullif(v_li->>'slab_id', '')::uuid;
      insert into private.ebay_order_line_items (order_id, line_item_id, slab_id, sku, listing_id, quantity, line_total, raw_response)
      values (v_order_uuid, v_li->>'line_item_id', v_slab, v_li->>'sku', nullif(v_li->>'listing_id', ''), nullif(v_li->>'quantity', '')::int, v_li->'line_total', coalesce(v_li->'raw_response', '{}'::jsonb))
      on conflict (order_id, line_item_id) do update
        set slab_id = excluded.slab_id, sku = excluded.sku, listing_id = excluded.listing_id,
            quantity = excluded.quantity, line_total = excluded.line_total, raw_response = excluded.raw_response;
      v_lines := v_lines + 1;
      if v_slab is not null then v_matched := v_matched + 1; else v_unmatched := v_unmatched + 1; end if;
    end loop;
  end loop;
  -- Persisted + matched/unmatched only. NO sold_comps, NO slab mutation here.
  return jsonb_build_object('orders', v_orders, 'line_items', v_lines, 'matched', v_matched, 'unmatched', v_unmatched);
end;
$$;
revoke all on function public.ebay_orders_persist(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ebay_orders_persist(uuid, jsonb) to service_role;

-- ── Sale application over ALREADY-PERSISTED lines (stale-rejecting) ──────────
create or replace function public.ebay_sales_apply(p_account_id uuid, p_sales jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_sale jsonb;
  v_persisted_slab uuid;
  v_slab uuid;
  v_cents bigint;
  v_sold_at timestamptz;
  v_currency text;
  v_ext text;
  v_applied int := 0;
  v_stale int := 0;
  v_unmatched int := 0;
begin
  for v_sale in select value from jsonb_array_elements(coalesce(p_sales, '[]'::jsonb)) loop
    -- Read the ALREADY-PERSISTED line; never re-fetch or re-persist provider data.
    select li.slab_id into v_persisted_slab
      from private.ebay_order_line_items li
      join private.ebay_orders o on o.id = li.order_id
     where o.ebay_account_id = p_account_id
       and o.order_id = v_sale->>'order_id'
       and li.line_item_id = v_sale->>'line_item_id'
     limit 1;
    if not found then v_unmatched := v_unmatched + 1; continue; end if;

    -- Stale-reject: the persisted mapping must still match the audited selection.
    v_slab := nullif(v_sale->>'slab_id', '')::uuid;
    if v_persisted_slab is null or v_slab is null or v_persisted_slab <> v_slab then
      v_stale := v_stale + 1; continue;
    end if;
    v_cents := nullif(v_sale->>'sold_price_cents', '')::bigint;
    if v_cents is null then v_stale := v_stale + 1; continue; end if;

    v_sold_at := coalesce(nullif(v_sale->>'sold_at', '')::timestamptz, now());
    v_currency := coalesce(nullif(v_sale->>'currency', ''), 'USD');
    v_ext := coalesce(nullif(v_sale->>'external_sale_id', ''), (v_sale->>'order_id') || ':' || (v_sale->>'line_item_id'));
    insert into public.sold_comps (slab_id, source, external_sale_id, sold_price_cents, currency, sold_at, raw_response)
    values (v_slab, 'EBAY_SELLER_ORDER', v_ext, v_cents, v_currency, v_sold_at, jsonb_build_object('order_id', v_sale->>'order_id', 'line_item_id', v_sale->>'line_item_id'))
    on conflict (source, external_sale_id) do update
      set sold_price_cents = excluded.sold_price_cents, currency = excluded.currency, sold_at = excluded.sold_at, raw_response = excluded.raw_response;
    update public.slabs set inventory_status = 'sold', sold_at = v_sold_at, sold_price_cents = v_cents where id = v_slab;
    v_applied := v_applied + 1;
  end loop;
  return jsonb_build_object('applied', v_applied, 'skipped_stale', v_stale, 'skipped_unmatched', v_unmatched);
end;
$$;
revoke all on function public.ebay_sales_apply(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ebay_sales_apply(uuid, jsonb) to service_role;

-- ── Durable listing-intent lifecycle ────────────────────────────────────────
create table if not exists public.ebay_listing_intents (
  id uuid primary key default gen_random_uuid(),
  ebay_account_id uuid not null references public.ebay_accounts(id) on delete cascade,
  slab_id uuid references public.slabs(id) on delete set null,
  sku text not null,
  fingerprint text,
  status text not null default 'preparing',
  offer_id text,
  listing_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ebay_account_id, sku)
);
alter table public.ebay_listing_intents enable row level security;
create policy ebay_listing_intents_admin_all on public.ebay_listing_intents
  for all to authenticated using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));
grant select, insert, update, delete on public.ebay_listing_intents to authenticated;
grant all on public.ebay_listing_intents to service_role;
create index if not exists idx_ebay_listing_intents_account_status on public.ebay_listing_intents (ebay_account_id, status);
