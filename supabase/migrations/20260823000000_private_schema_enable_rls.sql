-- ============================================================================
-- PR C.7.5: defense-in-depth — enable Row Level Security on the two remaining
-- private-schema tables that had it disabled.
--
--   * private.slab_storage_cleanup_queue
--   * private.ebay_publish_leases
--
-- These tables are already unreachable through the Data API: the `private` schema
-- is not exposed to PostgREST, and anon/authenticated have NO schema USAGE and NO
-- table privileges (only the SECURITY DEFINER RPCs, owned by the service role,
-- touch them). This is therefore hardening, not an active-exposure fix — it
-- resolves the advisor's "RLS disabled in public-reachable-schema-style" warning
-- and adds a second, independent barrier.
--
-- RLS is enabled with NO client policies. The service role (table owner / used by
-- the SECURITY DEFINER RPCs) BYPASSES RLS, so lease acquire/assert/release and the
-- storage-cleanup queue behavior are unaffected; anon/authenticated continue to
-- have zero access. NO anon or authenticated policy is added — that is intentional.
-- ============================================================================

alter table private.slab_storage_cleanup_queue enable row level security;
alter table private.ebay_publish_leases enable row level security;
