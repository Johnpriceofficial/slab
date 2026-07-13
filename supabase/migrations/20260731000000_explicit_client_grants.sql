-- GradedCardValue.com — explicit client grants and RLS init-plan tuning.

do $$
declare
  t text;
begin
  foreach t in array array[
    'slabs','slab_comps','slab_images','image_derivatives','ai_analysis_runs',
    'ai_field_evidence','pricecharting_products','slab_product_candidates',
    'slab_product_links','valuation_snapshots','sold_comps','marketplace_events',
    'webhook_inbox','integration_errors','audit_log','ebay_accounts',
    'ebay_inventory_locations','ebay_business_policies','ebay_listing_mappings',
    'ebay_notifications','ebay_sync_cursors','ebay_api_runs',
    'pricecharting_offers','pricecharting_offer_events','pricecharting_sync_runs'
  ] loop
    execute format('revoke all on public.%I from anon', t);
  end loop;

  foreach t in array array[
    'slab_images','image_derivatives','ai_analysis_runs','ai_field_evidence',
    'pricecharting_products','slab_product_candidates','slab_product_links',
    'valuation_snapshots','sold_comps','marketplace_events','webhook_inbox',
    'integration_errors','audit_log','ebay_accounts','ebay_inventory_locations',
    'ebay_business_policies','ebay_listing_mappings','ebay_notifications',
    'ebay_sync_cursors','ebay_api_runs'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_admin_all', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (public.is_admin((select auth.uid()))) with check (public.is_admin((select auth.uid())))',
      t || '_admin_all', t
    );
  end loop;
end $$;

-- Marketplace snapshots are applied by the service-role Edge sync, never by a
-- browser RPC. The function retains its internal admin/service guard as a
-- second barrier.
revoke execute on function public.apply_pricecharting_offer_snapshot(uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.apply_pricecharting_offer_snapshot(uuid, jsonb, text)
  to service_role;
