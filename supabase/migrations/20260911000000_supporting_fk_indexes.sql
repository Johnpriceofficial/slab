-- 20260911000000_supporting_fk_indexes.sql
--
-- G6: SUPPORTING INDEXES for unindexed foreign keys on the ACTIVE customer /
-- pricing / analysis path. Purely performance; no authorization or behaviour change.
-- See release/evidence/supporting-fk-indexes-plan.md.
--
-- TERMINOLOGY: these are *supporting* indexes for foreign keys (a plain btree on the
-- FK column), NOT "covering" indexes. A covering index would add INCLUDE columns to
-- satisfy a query from the index alone; none of these do.
--
-- SCOPE DECISION: the advisor reports 28 unindexed FKs. This migration adds 17 —
-- those on tables that grow with customer activity and are joined or filtered, or
-- that reference auth.users (so deleting a user does not seq-scan the child). The
-- remaining 11 FKs live on dormant, empty feature tables (builder_*, cgc_population_*,
-- ebay_notifications) and are intentionally DEFERRED until those features are active
-- (see the plan doc) — indexing empty tables is premature.
--
-- LOCK / DEPLOY: a plain CREATE INDEX takes a SHARE lock on the table — concurrent
-- READS continue, but WRITES are blocked for the duration of the build. On the
-- currently-tiny targets (0-26 rows) that is a few milliseconds. CREATE INDEX
-- CONCURRENTLY avoids the write block but has different restrictions and CANNOT run
-- inside a migration transaction (see the STOP CONDITION in the plan doc). IF NOT
-- EXISTS only checks the index NAME, not its definition — use the executable
-- verification in release/evidence/verify-supporting-fk-indexes.sql to prove each
-- index has the expected definition.
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
