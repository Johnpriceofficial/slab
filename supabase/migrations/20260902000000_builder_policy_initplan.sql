-- ============================================================================
-- Builder policy initplan reconciliation.
--
-- 20260901000000 (re)creates the seven builder_*_admin_read policies with the
-- plain qual `public.is_admin(auth.uid())`. Production's live builder policies
-- already carry the initplan-optimized form `public.is_admin((select auth.uid()))`
-- — the same rewrite 20260836000000 applied to twelve older policies — so
-- applying 20260901 there would silently regress that optimization. This
-- migration re-asserts the optimized expression as the canonical end state.
--
-- Scope is EXACTLY the seven builder admin-read policies: same table, same
-- command (SELECT), same role (authenticated), same USING semantics — only the
-- auth.uid() call moves into an initplan subselect, which PostgreSQL evaluates
-- once per statement instead of once per row. SELECT policies carry no WITH
-- CHECK. No grants, no revokes, no table, function, or data changes.
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
    execute format('drop policy if exists %I on public.%I;', t || '_admin_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_admin((select auth.uid())));', t || '_admin_read', t);
  end loop;
end $$;
