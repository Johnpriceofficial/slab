-- ============================================================================
-- Defense-in-depth RLS on the deletion-evidence ledger.
--
-- private.slab_deletion_tombstones (created 20260833000000) is the append-only
-- evidence trail for hard deletions. Its direct table privileges already
-- belong to postgres alone — no client role holds any — and every supported
-- access path is a postgres-owned SECURITY DEFINER function:
--   write: purge_slabs() inserts the tombstone inside the deletion transaction
--   read:  get_slab_deletion_tombstone() gates on is_admin() internally
-- It was, however, the only private-schema table without row-level security
-- (the 20260823000000 blanket enable predates it, and the ensure_rls event
-- trigger only enforces schema public). This migration closes that gap.
--
-- Enable-only, no policies: with RLS on and zero policies the table is
-- deny-all for every non-owner, while postgres (the table owner and the
-- definer of both trusted functions) is exempt from row security by default —
-- so the trusted write/read paths are untouched. FORCE ROW LEVEL SECURITY is
-- deliberately NOT used: it would subject the owner itself to the (empty)
-- policy set and break exactly those paths. The revokes below are explicit
-- re-assertions so the end state is deterministic from any starting ACL.
-- No data, columns, constraints, functions, or grants beyond this change.
-- ============================================================================

do $$
begin
  if to_regclass('private.slab_deletion_tombstones') is null then
    raise exception 'expected table private.slab_deletion_tombstones is missing — 20260833000000 must run first';
  end if;
end $$;

revoke all privileges on table private.slab_deletion_tombstones from public, anon, authenticated, service_role;

alter table private.slab_deletion_tombstones enable row level security;
