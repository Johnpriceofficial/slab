-- Executable verification for 20260911000000_supporting_fk_indexes.sql
--
-- Run against staging AFTER applying the migration. Asserts each of the 17 expected
-- indexes EXISTS and has the expected DEFINITION via pg_get_indexdef() — because
-- IF NOT EXISTS only checks the name, a same-name index with a different definition
-- would otherwise pass silently. Any failure RAISEs and aborts (fails the gate).
-- Read-only.

\set ON_ERROR_STOP on

do $$
declare
  r      record;
  v_def  text;
  v_fail integer := 0;
begin
  for r in
    with expected(idxname, tbl, col) as (values
      ('audit_log_owner_id_idx','audit_log','owner_id'),
      ('audit_log_actor_user_id_idx','audit_log','actor_user_id'),
      ('valuation_snapshots_owner_id_idx','valuation_snapshots','owner_id'),
      ('slab_images_created_by_idx','slab_images','created_by'),
      ('slabs_visual_confirmation_by_idx','slabs','visual_confirmation_by'),
      ('slab_pricecharting_events_created_by_idx','slab_pricecharting_events','created_by'),
      ('slab_product_links_confirmed_by_idx','slab_product_links','confirmed_by'),
      ('card_scan_reviews_resolved_by_idx','card_scan_reviews','resolved_by'),
      ('valuation_snapshots_pricecharting_product_id_idx','valuation_snapshots','pricecharting_product_id'),
      ('slab_product_links_pricecharting_product_id_idx','slab_product_links','pricecharting_product_id'),
      ('slab_product_candidates_pricecharting_product_id_idx','slab_product_candidates','pricecharting_product_id'),
      ('pricecharting_offer_events_offer_id_idx','pricecharting_offer_events','offer_id'),
      ('pricecharting_offer_events_actor_user_id_idx','pricecharting_offer_events','actor_user_id'),
      ('pricecharting_offers_created_by_idx','pricecharting_offers','created_by'),
      ('pricecharting_offers_updated_by_idx','pricecharting_offers','updated_by'),
      ('pricecharting_sync_runs_created_by_idx','pricecharting_sync_runs','created_by'),
      ('pricecharting_marketplace_settings_updated_by_idx','pricecharting_marketplace_settings','updated_by')
    ) select * from expected
  loop
    if to_regclass('public.'||r.idxname) is null then
      raise warning 'MISSING: index public.% does not exist', r.idxname;
      v_fail := v_fail + 1;
      continue;
    end if;
    v_def := pg_get_indexdef((to_regclass('public.'||r.idxname))::oid);
    -- Definition must be a btree on the expected table leading with the expected FK
    -- column. A same-name index on a different table/column/method fails this.
    if v_def !~ ('ON public\.'||r.tbl||' USING btree \('||r.col||'\b') then
      raise warning 'WRONG DEF: % -> %', r.idxname, v_def;
      v_fail := v_fail + 1;
    end if;
  end loop;

  if v_fail > 0 then
    raise exception 'FAIL: % of 17 supporting-index assertion(s) failed', v_fail;
  end if;
  raise notice 'PASS: all 17 supporting FK indexes exist with the expected table + leading column';
end $$;

-- (deferred) The 11 dormant-table FKs should STILL be reported unindexed by the
-- advisor after this migration (they are intentionally not added here):
--   builder_approvals(decided_by, requested_by), builder_audit_events(actor),
--   builder_runs(requested_by), builder_tool_calls(acting_user, approval_id, step_id),
--   cgc_population_cards(population_set_id), cgc_population_import_runs(requested_by, set_id),
--   ebay_notifications(ebay_account_id).
--
-- (manual) Re-run the Supabase performance advisor on staging and confirm exactly
-- the 17 above cleared and only the 11 deferred remain — this also proves none of the
-- 17 duplicated a pre-existing (redundant) index.
