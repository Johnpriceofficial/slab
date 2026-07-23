-- ============================================================================
-- PR C.8.1 (finding #6): return REAL confirmed durable order/line totals.
--
-- ebay_orders_persist previously returned `orders`/`line_items` = the count
-- PROCESSED in the current request. The sync handler treated `orders` as the
-- durable total, so retries and the 72h overlap re-processing inflated it. This
-- replaces the RPC to ALSO read back `confirmed_order_total` / `confirmed_line_total`
-- — the count of ALL unique durable rows for the account — so the watermark run's
-- durable total is idempotent under retries and overlap. Behavior is otherwise
-- unchanged (non-destructive persist; no sold_comps, no slab mutation).
-- ============================================================================

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
  v_confirmed_orders bigint;
  v_confirmed_lines bigint;
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

  -- CONFIRMED durable totals: all unique rows for the account (idempotent under
  -- retries + overlap re-processing), NOT the processed-this-request counts.
  select count(*) into v_confirmed_orders from private.ebay_orders where ebay_account_id = p_account_id;
  select count(*) into v_confirmed_lines
    from private.ebay_order_line_items li
    join private.ebay_orders o on o.id = li.order_id
   where o.ebay_account_id = p_account_id;

  return jsonb_build_object(
    'orders', v_orders, 'line_items', v_lines, 'matched', v_matched, 'unmatched', v_unmatched,
    'confirmed_order_total', v_confirmed_orders, 'confirmed_line_total', v_confirmed_lines
  );
end;
$$;
revoke all on function public.ebay_orders_persist(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ebay_orders_persist(uuid, jsonb) to service_role;
