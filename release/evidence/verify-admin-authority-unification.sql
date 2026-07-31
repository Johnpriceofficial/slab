-- Verification for 20260910000000_admin_authority_unification.sql
--
-- COVERAGE (be exact):
--   * Section 1 (A-H): executable READ-ONLY assertions — no INSERT/UPDATE/DELETE.
--   * Section 2 (K):   executable role/JWT-context checks using transaction-local
--                      SET LOCAL ROLE + request.jwt.claims. No persistent data change.
--                      Degrades to a NOTICE (run the manual steps) if the session
--                      cannot SET ROLE in this environment.
--   * Section 3 (J):   the unexpected app_metadata-only-admin ABORT test is a
--                      MANDATORY manual, rollback-only / disposable-staging scenario
--                      (it is mutating and is intentionally NOT automated here).
--
-- Run against an ISOLATED STAGING DB, AFTER applying the migration, as a
-- service/superuser session. Failed assertions RAISE and abort. No emails/secrets.

\set ON_ERROR_STOP on

-- ============================ Section 1: A-H (read-only) ============================
do $$
declare v_n integer;
begin
  -- (A) is_admin() reflects user_roles for EVERY user (canonical source is wired)
  select count(*) into v_n
    from auth.users u
   where public.is_admin(u.id)
      <> exists (select 1 from public.user_roles ur where ur.user_id=u.id and ur.role='administrator');
  if v_n <> 0 then raise exception 'FAIL(A): is_admin() disagrees with user_roles for % user(s)', v_n; end if;

  -- (B) slab_admins fully backfilled into user_roles (existing user_roles admins are
  --     untouched by construction; proves idempotency-of-effect: a re-run inserts 0 rows).
  select count(*) into v_n
    from public.slab_admins sa
   where not exists (select 1 from public.user_roles ur where ur.user_id=sa.user_id and ur.role='administrator');
  if v_n <> 0 then raise exception 'FAIL(B): % slab_admins entr(y/ies) not backfilled into user_roles', v_n; end if;

  -- (C) consistency gate held: no app_metadata admin left unrepresented
  select count(*) into v_n
    from auth.users u
   where coalesce((u.raw_app_meta_data->>'graded_card_value_admin')::boolean,false)
     and not exists (select 1 from public.user_roles ur where ur.user_id=u.id and ur.role='administrator');
  if v_n <> 0 then raise exception 'FAIL(C): % app_metadata admin(s) unrepresented in user_roles — the gate should have aborted', v_n; end if;

  -- (D) every canonical administrator resolves is_admin()=true (covers owner + test-admin)
  select count(*) into v_n from public.user_roles ur where ur.role='administrator' and not public.is_admin(ur.user_id);
  if v_n <> 0 then raise exception 'FAIL(D): % canonical administrator(s) resolve is_admin()=false', v_n; end if;

  -- (E) customer / non-canonical users resolve is_admin()=false
  select count(*) into v_n
    from auth.users u
   where public.is_admin(u.id)
     and not exists (select 1 from public.user_roles ur where ur.user_id=u.id and ur.role='administrator');
  if v_n <> 0 then raise exception 'FAIL(E): % non-canonical user(s) resolve is_admin()=true', v_n; end if;

  -- (F) self-scoped helper EXECUTE grants. PUBLIC is checked via
  --     information_schema.routine_privileges (grantee='PUBLIC'); anon/authenticated are
  --     real roles checked with has_function_privilege().
  if exists (
    select 1 from information_schema.routine_privileges
     where routine_schema='public' and routine_name='is_current_user_admin'
       and grantee='PUBLIC' and privilege_type='EXECUTE'
  ) then raise exception 'FAIL(F): PUBLIC has EXECUTE on is_current_user_admin()'; end if;
  if has_function_privilege('anon','public.is_current_user_admin()','EXECUTE')
     then raise exception 'FAIL(F): anon can execute is_current_user_admin()'; end if;
  if not has_function_privilege('authenticated','public.is_current_user_admin()','EXECUTE')
     then raise exception 'FAIL(F): authenticated cannot execute is_current_user_admin()'; end if;

  -- (G) STAGED invariant (G4 is PARTIAL): arbitrary-user is_admin(uuid) EXECUTE is
  --     STILL granted to authenticated — RLS is_admin(auth.uid()) needs it until the
  --     44 policies move to the self-scoped helper. Revoking now would break RLS.
  if not has_function_privilege('authenticated','public.is_admin(uuid)','EXECUTE') then
    raise exception 'FAIL(G): is_admin(uuid) EXECUTE was revoked from authenticated too early — RLS would break';
  end if;

  -- (H) is_admin() keeps SECURITY DEFINER + a pinned search_path
  perform 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='is_admin' and p.prosecdef
     and exists (select 1 from unnest(p.proconfig) x where x ilike 'search_path=%');
  if not found then raise exception 'FAIL(H): is_admin() lost SECURITY DEFINER or its pinned search_path'; end if;

  raise notice 'PASS: read-only assertions A-H';
end $$;

-- ==================== Section 2: K — executable role/JWT context ====================
-- Uses transaction-local SET LOCAL ROLE + request.jwt.claims; reverts automatically at
-- statement end (autocommit) and changes no persistent data. A wrong RESULT fails; an
-- environment that cannot SET ROLE degrades to a NOTICE pointing at the manual steps.
do $$
declare v_admin uuid; v_customer uuid; v_res boolean;
begin
  select ur.user_id into v_admin from public.user_roles ur where ur.role='administrator' limit 1;
  select u.id into v_customer from auth.users u
    where not exists (select 1 from public.user_roles ur where ur.user_id=u.id and ur.role='administrator')
    limit 1;

  -- anon must be DENIED execute on the self-scoped helper
  begin
    set local role anon;
  exception when insufficient_privilege then
    reset role;
    raise notice 'K SKIPPED (session cannot SET ROLE anon): run the manual role/JWT scenarios below';
    return;
  end;
  begin
    perform public.is_current_user_admin();
    reset role;
    raise exception 'FAIL(K-anon): anon executed is_current_user_admin()';
  exception when insufficient_privilege then
    reset role;  -- expected: EXECUTE denied
  end;

  -- authenticated + administrator JWT -> true
  if v_admin is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);
    set local role authenticated;
    v_res := public.is_current_user_admin();
    reset role;
    if v_res is distinct from true then raise exception 'FAIL(K-admin): is_current_user_admin() = % (want true)', v_res; end if;
  end if;

  -- authenticated + customer JWT -> false
  if v_customer is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role','authenticated')::text, true);
    set local role authenticated;
    v_res := public.is_current_user_admin();
    reset role;
    if v_res is distinct from false then raise exception 'FAIL(K-customer): is_current_user_admin() = % (want false)', v_res; end if;
  end if;

  perform set_config('request.jwt.claims', '', true);
  raise notice 'PASS(K): anon denied; administrator JWT -> true; customer JWT -> false';
end $$;

-- ==================== Section 3: J — MANDATORY manual abort test ====================
-- The unexpected app_metadata-only-admin ABORT is mutating and is NOT automated here.
-- On a DISPOSABLE staging snapshot:
--   1. Flag a spare non-admin user (not in user_roles/slab_admins) as app_metadata admin.
--   2. Re-apply the migration; it MUST abort with message 'ADMIN_UNIFY_ABORT: ...'.
--   3. Discard the snapshot (or run inside a transaction you ROLL BACK).
