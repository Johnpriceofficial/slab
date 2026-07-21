-- ============================================================================
-- PR B: order + finance persistence through SECURITY DEFINER RPCs.
--
-- The order-sync / finances-sync paths previously wrote to the `private` schema
-- via `admin.schema("private").from(...)`, which fails PGRST106 because `private`
-- is not exposed to the Data API. These RPCs move those writes behind
-- service_role-only definer functions (mirroring the account-discovery RPCs).
--
--  * ebay_orders_apply is TRANSACTIONAL: an order, all its line items, and any
--    resulting sold_comps + slab "sold" transitions are one atomic unit — the
--    whole batch commits or none of it does. It returns CONFIRMED counts.
--    Callers pass this ONLY on the explicit APPLY_SALES gate; the default
--    order-sync path is a non-mutating audit and never calls it.
--  * ebay_finance_transactions_apply is IDEMPOTENT: repeated syncs upsert on
--    (ebay_account_id, transaction_id) and converge. Recording fees/payouts is
--    non-destructive, so finance-sync applies it directly.
--
-- Sale application writes the inventory status as the lowercase enum value
-- `sold` required by slabs_inventory_status_chk (the prior TS wrote "Sold",
-- which the check constraint rejects).
-- ============================================================================

-- Order + line-item + sale application, all in one transaction.
create or replace function public.ebay_orders_apply(p_account_id uuid, p_orders jsonb)
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
  v_cents bigint;
  v_sold_at timestamptz;
  v_orders int := 0;
  v_line_items int := 0;
  v_sales int := 0;
begin
  for v_order in select value from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb)) loop
    if coalesce(v_order->>'order_id', '') = '' then continue; end if;
    insert into private.ebay_orders (ebay_account_id, order_id, order_status, buyer_data, pricing_summary, raw_response, updated_at)
    values (
      p_account_id, v_order->>'order_id', v_order->>'order_status',
      v_order->'buyer_data', v_order->'pricing_summary', coalesce(v_order->'raw_response', '{}'::jsonb), now()
    )
    on conflict (ebay_account_id, order_id) do update
      set order_status = excluded.order_status, buyer_data = excluded.buyer_data,
          pricing_summary = excluded.pricing_summary, raw_response = excluded.raw_response, updated_at = now()
    returning id into v_order_uuid;
    v_orders := v_orders + 1;

    for v_li in select value from jsonb_array_elements(coalesce(v_order->'line_items', '[]'::jsonb)) loop
      if coalesce(v_li->>'line_item_id', '') = '' then continue; end if;
      v_slab := nullif(v_li->>'slab_id', '')::uuid;
      insert into private.ebay_order_line_items (order_id, line_item_id, slab_id, sku, listing_id, quantity, line_total, raw_response)
      values (
        v_order_uuid, v_li->>'line_item_id', v_slab, v_li->>'sku', nullif(v_li->>'listing_id', ''),
        nullif(v_li->>'quantity', '')::int, v_li->'line_total', coalesce(v_li->'raw_response', '{}'::jsonb)
      )
      on conflict (order_id, line_item_id) do update
        set slab_id = excluded.slab_id, sku = excluded.sku, listing_id = excluded.listing_id,
            quantity = excluded.quantity, line_total = excluded.line_total, raw_response = excluded.raw_response;
      v_line_items := v_line_items + 1;

      -- Only mapped line items with a real sold amount move inventory. Idempotent.
      v_cents := nullif(v_li->>'sold_price_cents', '')::bigint;
      if v_slab is not null and v_cents is not null then
        v_sold_at := coalesce(nullif(v_li->>'sold_at', '')::timestamptz, now());
        insert into public.sold_comps (slab_id, source, external_sale_id, sold_price_cents, currency, sold_at, raw_response)
        values (v_slab, 'EBAY_SELLER_ORDER', v_li->>'external_sale_id', v_cents, coalesce(nullif(v_li->>'currency', ''), 'USD'), v_sold_at, coalesce(v_li->'raw_response', '{}'::jsonb))
        on conflict (source, external_sale_id) do update
          set slab_id = excluded.slab_id, sold_price_cents = excluded.sold_price_cents,
              currency = excluded.currency, sold_at = excluded.sold_at, raw_response = excluded.raw_response;
        update public.slabs
           set inventory_status = 'sold', sold_at = v_sold_at, sold_price_cents = v_cents
         where id = v_slab;
        v_sales := v_sales + 1;
      end if;
    end loop;
  end loop;

  update public.ebay_accounts set last_synced_at = now() where id = p_account_id;
  return jsonb_build_object('orders', v_orders, 'line_items', v_line_items, 'sales_applied', v_sales);
end;
$$;
revoke all on function public.ebay_orders_apply(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ebay_orders_apply(uuid, jsonb) to service_role;

-- Idempotent finance-transaction upsert; returns the confirmed post-write count.
create or replace function public.ebay_finance_transactions_apply(p_account_id uuid, p_transactions jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_tx jsonb;
  v_applied int := 0;
  v_total int;
begin
  for v_tx in select value from jsonb_array_elements(coalesce(p_transactions, '[]'::jsonb)) loop
    if coalesce(v_tx->>'transaction_id', '') = '' then continue; end if;
    insert into private.ebay_financial_transactions (ebay_account_id, transaction_id, order_id, transaction_type, transaction_status, amount, fee_basis_amount, raw_response, occurred_at)
    values (
      p_account_id, v_tx->>'transaction_id', nullif(v_tx->>'order_id', ''),
      v_tx->>'transaction_type', v_tx->>'transaction_status',
      v_tx->'amount', v_tx->'fee_basis_amount', coalesce(v_tx->'raw_response', '{}'::jsonb),
      nullif(v_tx->>'occurred_at', '')::timestamptz
    )
    on conflict (ebay_account_id, transaction_id) do update
      set order_id = excluded.order_id, transaction_type = excluded.transaction_type,
          transaction_status = excluded.transaction_status, amount = excluded.amount,
          fee_basis_amount = excluded.fee_basis_amount, raw_response = excluded.raw_response,
          occurred_at = excluded.occurred_at;
    v_applied := v_applied + 1;
  end loop;
  -- CONFIRMED post-write total for this account (read back from the table), so a
  -- repeated identical sync reports the same total, never a doubled one.
  select count(*) into v_total from private.ebay_financial_transactions where ebay_account_id = p_account_id;
  return jsonb_build_object('transactions', v_applied, 'total', v_total);
end;
$$;
revoke all on function public.ebay_finance_transactions_apply(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ebay_finance_transactions_apply(uuid, jsonb) to service_role;
