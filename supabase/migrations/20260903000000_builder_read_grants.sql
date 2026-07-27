-- ============================================================================
-- Builder admin reads: restore least-privilege table grants.
--
-- The /builder administrator page reads builder tables from the browser as an
-- `authenticated` admin, relying on the builder_*_admin_read RLS policies
-- (initplan form, 20260902000000). Production's out-of-band hardening revoked
-- authenticated SELECT on these tables, which broke that designed read path —
-- an RLS policy TO authenticated is dead configuration without the SELECT
-- privilege beneath it.
--
-- This migration makes the client-role privilege state DETERMINISTIC and
-- minimal on the seven builder tables, regardless of which grant state an
-- environment starts from (fresh-rebuild defaults or production's revokes):
--   1. revoke ALL client-role privileges (anon AND authenticated), then
--   2. grant back exactly SELECT to authenticated.
-- End state: anon holds nothing; authenticated holds SELECT only (no INSERT,
-- UPDATE, DELETE, TRUNCATE, REFERENCES, or TRIGGER); writes remain
-- service_role / SECURITY DEFINER RPC only; RLS stays enabled and the
-- admin-read policies remain the authorization boundary — untouched here.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'builder_connections','builder_runs','builder_steps','builder_approvals',
    'builder_tool_calls','builder_audit_events','builder_policy_rules'
  ] loop
    if to_regclass(format('public.%I', t)) is null then
      raise exception 'expected table public.% is missing — 20260901000000 must run first', t;
    end if;
    execute format('revoke all privileges on public.%I from anon, authenticated;', t);
    execute format('grant select on public.%I to authenticated;', t);
  end loop;
end $$;
