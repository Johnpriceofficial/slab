-- 20260917000000_drop_legacy_public_ebay_oauth_tables.sql
--
-- Retire the two legacy PUBLIC-schema eBay OAuth tables. The seller OAuth flow
-- moved to the private schema long ago and is the sole authority today:
--   - refresh/access tokens are stored encrypted in `private.ebay_oauth_credentials`;
--   - authorize-flow state hashes live in `private.ebay_oauth_states`, written by
--     `ebay_oauth_state_create_single_flight` and cleared by `_consume`.
--
-- `public.ebay_oauth_tokens` and `public.ebay_oauth_states` are fully retired.
-- Verified against production (rcbwemkfcefarqnlgrmv) on 2026-08-04:
--   * 0 live rows and 0 insert/update/delete activity on both tables;
--   * 0 inbound foreign keys, 0 dependent views/materialized views, 0 triggers;
--   * no edge function or RPC references the public-schema tables (grep-clean);
--   * the frontend OAuth-browser-safety guard already forbids any dependency on
--     `ebay_oauth_tokens`.
--
-- Idempotent and clean-from-zero safe: earlier migrations create these tables
-- (with their RLS + policies), and this migration drops them at the tail of the
-- chain — so `drop ... if exists` produces the same final schema whether the
-- chain is replayed from zero or applied to the live database. Each table's own
-- policies, grants and indexes are removed with it. `restrict` is deliberate: it
-- makes the drop fail loudly rather than silently cascade if any dependent is
-- ever introduced (there are none today, verified above).

drop table if exists public.ebay_oauth_tokens restrict;
drop table if exists public.ebay_oauth_states restrict;
