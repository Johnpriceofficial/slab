-- Executable verification for 20260911000000_supporting_fk_indexes.sql
--
-- Run against staging AFTER applying the migration. For each of the 17 expected
-- (table, FK column) targets this asserts:
--   1. the expected NAMED index exists and pg_get_indexdef() matches the expected
--      table + leading FK column (IF NOT EXISTS only checks the name, so a same-name
--      index with a different definition would otherwise pass silently);
--   2. EXACTLY ONE equivalent supporting index exists (valid, ready, non-partial,
--      non-expression btree whose FIRST key column is the FK column) — this catches a
--      differently-NAMED redundant index and a missing index without relying on the
--      advisor. 0 = missing, >1 = redundant; both FAIL.
-- Any failure RAISEs and aborts (fails the gate). Read-only.

\set ON_ERROR_STOP on

do $$
declare
  r        record;
  v_def    text;
  v_attnum smallint;
  v_equiv  integer;
  v_fail   integer := 0;
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
    -- resolve the FK column's attnum (must exist and not be dropped)
    select a.attnum into v_attnum
      from pg_attribute a
     where a.attrelid = to_regclass('public.'||r.tbl)
       and a.attname = r.col and not a.attisdropped;
    if v_attnum is null then
      raise warning 'MISSING COLUMN: public.%.% does not exist', r.tbl, r.col;
      v_fail := v_fail + 1; continue;
    end if;

    -- 1) expected NAMED index exists with the expected definition
    if to_regclass('public.'||r.idxname) is null then
      raise warning 'MISSING: index public.% does not exist', r.idxname;
      v_fail := v_fail + 1;
    else
      v_def := pg_get_indexdef((to_regclass('public.'||r.idxname))::oid);
      if v_def !~ ('ON public\.'||r.tbl||' USING btree \('||r.col||'\y') then
        raise warning 'WRONG DEF: % -> %', r.idxname, v_def;
        v_fail := v_fail + 1;
      end if;
    end if;

    -- 2) exactly ONE equivalent supporting index (any name) leads with the FK column
    select count(*) into v_equiv
      from pg_index i
      join pg_class ic on ic.oid = i.indexrelid
      join pg_am    am on am.oid = ic.relam
     where i.indrelid = to_regclass('public.'||r.tbl)
       and am.amname = 'btree'
       and i.indisvalid and i.indisready
       and i.indpred is null      -- exclude partial indexes
       and i.indexprs is null     -- exclude expression indexes
       and i.indkey[0] = v_attnum; -- FK column is the FIRST key column
    if v_equiv = 0 then
      raise warning 'NO EQUIVALENT INDEX: public.%(%) has no valid/ready btree leading with the FK column', r.tbl, r.col;
      v_fail := v_fail + 1;
    elsif v_equiv > 1 then
      raise warning 'REDUNDANT: public.%(%) has % equivalent supporting indexes (expected exactly 1)', r.tbl, r.col, v_equiv;
      v_fail := v_fail + 1;
    end if;
  end loop;

  if v_fail > 0 then
    raise exception 'FAIL: % supporting-index assertion(s) failed', v_fail;
  end if;
  raise notice 'PASS: 17 supporting FK indexes — each present, correctly defined, and exactly one equivalent index';
end $$;

-- (deferred) The 11 dormant-table FKs should STILL be reported unindexed by the advisor
-- after this migration (intentionally not added here):
--   builder_approvals(decided_by, requested_by), builder_audit_events(actor),
--   builder_runs(requested_by), builder_tool_calls(acting_user, approval_id, step_id),
--   cgc_population_cards(population_set_id), cgc_population_import_runs(requested_by, set_id),
--   ebay_notifications(ebay_account_id).
--
-- (secondary, manual) Re-run the Supabase performance advisor on staging to confirm the
-- 17 cleared and only the 11 deferred remain. This is confirmation, not the sole
-- redundancy proof — the exactly-one-equivalent-index assertion above is authoritative.
