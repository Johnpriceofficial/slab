-- Verification for 20260910000000_admin_authority_unification.sql
--
-- COVERAGE (be exact):
--   * Section 1 (A-H): executable READ-ONLY assertions — no INSERT/UPDATE/DELETE.
--   * Section 2 (K):   MANDATORY, FAIL-CLOSED executable role/JWT-context checks using
--                      transaction-local SET LOCAL ROLE + request.jwt.claims (no
--                      persistent change). If the session cannot switch roles / set
--                      claims, or the required administrator/customer fixtures are
--                      missing, the script RAISES and FAILS. It NEVER skips a
--                      security-context test — a test that did not run must not pass.
--   * Section 3 (J):   the unexpected app_metadata-only-admin ABORT test is a
--                      MANDATORY manual, rollback-only / disposable-staging scenario
--                      (it mutates and is intentionally NOT automated here); the
--                      staging report must record its execution + outcome (see below).
--
-- Run against an ISOLATED STAGING DB, AFTER applying the migration, as a
-- service/superuser session THAT CAN SET ROLE. Failed assertions RAISE and abort.
-- No emails/secrets.

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

  -- (F) self-scoped helper EXECUTE grants. PUBLIC via information_schema.routine_privileges
  --     (grantee='PUBLIC'); anon/authenticated are real roles via has_function_privilege().
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

-- ============= Section 2: K — MANDATORY, FAIL-CLOSED role/JWT context =============
-- Transaction-local SET LOCAL ROLE + request.jwt.claims (no persistent change; settings
-- revert at statement end). Fail-closed: missing role-switch capability OR missing
-- admin/customer fixtures RAISE — the security-context tests are never skipped.
do $$
declare v_admin uuid; v_customer uuid; v_res boolean;
begin
  -- (K0) fixtures REQUIRED — never silently skip
  select ur.user_id into v_admin
    from public.user_roles ur where ur.role='administrator' limit 1;
  if v_admin is null then
    raise exception 'FAIL(K-fixture): no canonical administrator (user_roles administrator) exists to test';
  end if;
  select u.id into v_customer
    from auth.users u
   where not exists (select 1 from public.user_roles ur where ur.user_id=u.id and ur.role='administrator')
   limit 1;
  if v_customer is null then
    raise exception 'FAIL(K-fixture): no non-administrator customer exists to test';
  end if;

  -- (K1) capability probe — if the session cannot switch roles / set jwt claims, HARD FAIL.
  begin
    set local role anon;          reset role;
    set local role authenticated; reset role;
    perform set_config('request.jwt.claims', '{}', true);
    perform set_config('request.jwt.claims', '',  true);
  exception when others then
    raise exception 'FAIL(K-env): this session cannot SET LOCAL ROLE / set request.jwt.claims (%). Run this gate as a role that can (service/superuser); a security-context test must not be skipped.', sqlerrm;
  end;

  -- (K2) anon must be DENIED execute on the self-scoped helper
  set local role anon;
  begin
    perform public.is_current_user_admin();
    reset role;
    raise exception 'FAIL(K-anon): anon executed is_current_user_admin()';
  exception
    when insufficient_privilege then
      reset role;  -- expected: EXECUTE denied (capability already proven in K1)
  end;

  -- (K3) authenticated + administrator JWT -> true
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.is_current_user_admin();
  reset role;
  if v_res is distinct from true then
    raise exception 'FAIL(K-admin): administrator JWT is_current_user_admin() = % (want true)', v_res;
  end if;

  -- (K4) authenticated + customer JWT -> false
  perform set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.is_current_user_admin();
  reset role;
  if v_res is distinct from false then
    raise exception 'FAIL(K-customer): customer JWT is_current_user_admin() = % (want false)', v_res;
  end if;

  perform set_config('request.jwt.claims', '', true);
  raise notice 'PASS(K): fixtures present; anon denied; administrator JWT -> true; customer JWT -> false';
end $$;

-- ==================== Section 3: J — MANDATORY manual abort test ====================
-- The unexpected app_metadata-only-admin ABORT is mutating and is NOT automated here.
-- On a DISPOSABLE staging snapshot (or a transaction you ROLL BACK):
--   1. Flag a spare non-admin user (not in user_roles/slab_admins) as app_metadata admin.
--   2. Re-apply the migration; it MUST abort with message 'ADMIN_UNIFY_ABORT: ...'.
--   3. Roll back / discard the snapshot.
-- The staging report MUST record: scenario executed; ADMIN_UNIFY_ABORT observed;
-- transaction/snapshot discarded; no persistent account metadata retained.
