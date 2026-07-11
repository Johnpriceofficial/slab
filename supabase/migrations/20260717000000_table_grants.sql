-- ============================================================================
-- SlabVault — table privilege grants for the PostgREST API roles.
--
-- The prior migrations enable RLS and create policies + grant EXECUTE on the
-- RPCs, but never GRANT table-level privileges. Supabase's default privileges
-- did not cover these migration-created tables on this project, so every direct
-- (non-RPC) table access failed with "permission denied for table …" — breaking
-- the frontend's direct reads/writes (fetchSlabs, updateSlab, comps CRUD) and
-- the service-role test/admin paths.
--
-- RLS remains the security boundary: these grants only let a request REACH the
-- RLS policies (which still require is_admin) instead of being rejected at the
-- privilege layer. `anon` is intentionally granted nothing — the app requires an
-- authenticated admin. SECURITY DEFINER RPCs (create_slab, is_admin, etc.) are
-- unaffected either way; they run as the owner.
-- ============================================================================

-- authenticated: direct table access used by the frontend (RLS restricts to admins).
grant select, insert, update, delete on public.slabs         to authenticated;
grant select, insert, update, delete on public.slab_comps    to authenticated;
grant select, insert, update, delete on public.slab_admins   to authenticated;
grant select, insert, update, delete on public.slab_settings to authenticated;

-- service_role: full backend access (Edge Functions use RPCs, but the service
-- role also performs direct maintenance + is used by the integration tests).
grant all on public.slabs           to service_role;
grant all on public.slab_comps      to service_role;
grant all on public.slab_admins     to service_role;
grant all on public.slab_settings   to service_role;
grant all on public.api_rate_limits to service_role;
