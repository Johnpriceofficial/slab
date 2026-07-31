-- 20260911000000_covering_indexes_active_fks.sql
--
-- G6: covering indexes for unindexed foreign keys on the ACTIVE customer /
-- pricing / analysis path. Purely performance; no authorization or behaviour
-- change. See release/evidence/covering-indexes-plan.md.
--
-- SCOPE DECISION: the advisor reports 28 unindexed FKs. This migration adds 17 —
-- those on tables that grow with customer activity and are joined or filtered, or
-- that reference auth.users (so deleting a user does not seq-scan the child). The
-- remaining 11 FKs live on dormant, empty feature tables (builder_*, cgc_population_*,
-- ebay_notifications) and are intentionally DEFERRED until those features are active
-- (see the plan doc) — indexing empty tables is premature.
--
-- LOCK / DEPLOY: all target tables are currently tiny (0–26 rows), so a plain
-- CREATE INDEX takes a brief ACCESS EXCLUSIVE lock for milliseconds. If any target
-- is large at apply time, create THAT index out-of-band with
-- `CREATE INDEX CONCURRENTLY` (cannot run inside a migration transaction) instead.
-- IF NOT EXISTS makes this migration idempotent and re-runnable.
--
-- ORDERING: apply after the F4 migration-ledger reconciliation. Draft — not applied
-- to any environment; no production change.

-- auth.users-referencing FKs on core / ownership tables (user-deletion + owner-scoped reads)
create index if not exists audit_log_owner_id_idx              on public.audit_log (owner_id);
create index if not exists audit_log_actor_user_id_idx         on public.audit_log (actor_user_id);
create index if not exists valuation_snapshots_owner_id_idx    on public.valuation_snapshots (owner_id);
create index if not exists slab_images_created_by_idx          on public.slab_images (created_by);
create index if not exists slabs_visual_confirmation_by_idx    on public.slabs (visual_confirmation_by);
create index if not exists slab_pricecharting_events_created_by_idx on public.slab_pricecharting_events (created_by);
create index if not exists slab_product_links_confirmed_by_idx on public.slab_product_links (confirmed_by);
create index if not exists card_scan_reviews_resolved_by_idx   on public.card_scan_reviews (resolved_by);

-- join FKs on the pricing / valuation-evidence path (slab -> pricecharting product / offer)
create index if not exists valuation_snapshots_pricecharting_product_id_idx     on public.valuation_snapshots (pricecharting_product_id);
create index if not exists slab_product_links_pricecharting_product_id_idx      on public.slab_product_links (pricecharting_product_id);
create index if not exists slab_product_candidates_pricecharting_product_id_idx on public.slab_product_candidates (pricecharting_product_id);
create index if not exists pricecharting_offer_events_offer_id_idx              on public.pricecharting_offer_events (offer_id);

-- pricecharting admin/audit FKs (reference auth.users; support user-deletion + audit reads)
create index if not exists pricecharting_offer_events_actor_user_id_idx          on public.pricecharting_offer_events (actor_user_id);
create index if not exists pricecharting_offers_created_by_idx                    on public.pricecharting_offers (created_by);
create index if not exists pricecharting_offers_updated_by_idx                    on public.pricecharting_offers (updated_by);
create index if not exists pricecharting_sync_runs_created_by_idx                 on public.pricecharting_sync_runs (created_by);
create index if not exists pricecharting_marketplace_settings_updated_by_idx      on public.pricecharting_marketplace_settings (updated_by);

-- DEFERRED (dormant/empty feature tables — add when the feature is activated):
--   builder_approvals(decided_by, requested_by), builder_audit_events(actor),
--   builder_runs(requested_by), builder_tool_calls(acting_user, approval_id, step_id),
--   cgc_population_cards(population_set_id), cgc_population_import_runs(requested_by, set_id),
--   ebay_notifications(ebay_account_id).
