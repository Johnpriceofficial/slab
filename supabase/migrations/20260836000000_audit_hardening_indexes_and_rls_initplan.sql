-- Audit hardening: FK covering indexes, unused-index cleanup, RLS init-plan optimization.
-- Performance-only. NO security-semantics change; NO REVOKE (see release constraint 1). Reversible.
begin;
create index if not exists ebay_listing_intents_slab_id_idx on public.ebay_listing_intents (slab_id);
create index if not exists pricecharting_offer_events_slab_id_idx on public.pricecharting_offer_events (slab_id);
create index if not exists slabs_cgc_population_card_id_idx on public.slabs (cgc_population_card_id);
drop index if exists public.slabs_certification_idx;
drop index if exists public.slabs_grader_idx;
drop index if exists public.slabs_grade_idx;
drop index if exists public.slabs_language_idx;
drop index if exists public.slabs_confidence_idx;
drop index if exists public.slabs_owner_idx;
drop index if exists public.pricecharting_offer_events_offer_idx;
drop index if exists public.cgc_pop_sets_norm_name_idx;
drop index if exists public.cgc_pop_cards_set_idx;
drop index if exists public.cgc_pop_cards_norm_name_idx;
drop index if exists public.cgc_pop_cards_norm_number_idx;
drop index if exists public.cgc_pop_runs_set_idx;
drop index if exists public.cgc_pop_runs_status_idx;
drop index if exists public.pricecharting_offers_status_idx;
drop index if exists public.cards_identity_idx;
drop index if exists public.cards_inventory_sequence_idx;
drop index if exists public.valuation_snapshots_owner_idx;
drop index if exists public.audit_log_owner_idx;
drop index if exists public.idx_valuation_snapshots_pricecharting_product_id;
drop index if exists public.idx_slab_product_candidates_pricecharting_product_id;
drop index if exists public.idx_slab_product_links_pricecharting_product_id;
drop index if exists public.idx_ebay_notifications_account_received;
drop index if exists public.idx_ebay_listing_intents_account_status;
alter policy "cgc_pop_cards admin read" on public.cgc_population_cards using (is_admin((select auth.uid())));
alter policy "cgc_pop_runs admin read" on public.cgc_population_import_runs using (is_admin((select auth.uid())));
alter policy "cgc_pop_sets admin read" on public.cgc_population_sets using (is_admin((select auth.uid())));
alter policy "ebay_listing_intents_admin_all" on public.ebay_listing_intents using (is_admin((select auth.uid()))) with check (is_admin((select auth.uid())));
alter policy "ebay_sync_state_admin_read" on public.ebay_sync_state using (is_admin((select auth.uid())));
alter policy "pricecharting_marketplace_settings admin all" on public.pricecharting_marketplace_settings using (is_admin((select auth.uid()))) with check (is_admin((select auth.uid())));
alter policy "pricecharting_offer_events admin insert" on public.pricecharting_offer_events with check (is_admin((select auth.uid())));
alter policy "pricecharting_offer_events admin read" on public.pricecharting_offer_events using (is_admin((select auth.uid())));
alter policy "pricecharting_offers admin all" on public.pricecharting_offers using (is_admin((select auth.uid()))) with check (is_admin((select auth.uid())));
alter policy "pricecharting_sync_runs admin all" on public.pricecharting_sync_runs using (is_admin((select auth.uid()))) with check (is_admin((select auth.uid())));
alter policy "slab_admins admin all" on public.slab_admins using (is_admin((select auth.uid()))) with check (is_admin((select auth.uid())));
alter policy "slab_settings admin all" on public.slab_settings using (is_admin((select auth.uid()))) with check (is_admin((select auth.uid())));
commit;

-- Rollback:
-- 1. Drop ebay_listing_intents_slab_id_idx, pricecharting_offer_events_slab_id_idx,
--    and slabs_cgc_population_card_id_idx.
-- 2. Recreate dropped indexes from the migration history that originally introduced them.
-- 3. Restore the twelve policy expressions to their prior definitions from git history.
--
-- If public.slabs becomes large, move that index to an explicitly reviewed out-of-band
-- CREATE INDEX CONCURRENTLY operation; CONCURRENTLY cannot run inside this transaction.
