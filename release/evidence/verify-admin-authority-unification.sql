-- Executable READ-ONLY verification for 20260910000000_admin_authority_unification.sql
--
-- Run against an ISOLATED STAGING DB, AFTER applying the migration, as a
-- service/superuser session. Every failed assertion RAISEs and aborts, failing the
-- staging gate. This script performs NO INSERT/UPDATE/DELETE and stores no emails
-- or secrets. Mutating negative-tests (J, K) are documented as manual steps.

\set ON_ERROR_STOP on

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
  --     untouched by construction; this also PROVES idempotency-of-effect: the target
  --     set is complete, so a re-run of the backfill inserts 0 rows).
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

  -- (F) self-scoped helper EXECUTE: authenticated only; anon + public denied
  if has_function_privilege('anon','public.is_current_user_admin()','EXECUTE')          then raise exception 'FAIL(F): anon can execute is_current_user_admin()'; end if;
  if has_function_privilege('public','public.is_current_user_admin()','EXECUTE')        then raise exception 'FAIL(F): public can execute is_current_user_admin()'; end if;
  if not has_function_privilege('authenticated','public.is_current_user_admin()','EXECUTE') then raise exception 'FAIL(F): authenticated cannot execute is_current_user_admin()'; end if;

  -- (G) STAGED invariant (G4 is PARTIAL): arbitrary-user is_admin(uuid) EXECUTE is
  --     STILL granted to authenticated — RLS is_admin(auth.uid()) needs it until the
  --     44 policies move to the self-scoped helper. Revoking it now would break RLS.
  if not has_function_privilege('authenticated','public.is_admin(uuid)','EXECUTE') then
    raise exception 'FAIL(G): is_admin(uuid) EXECUTE was revoked from authenticated too early — RLS would break';
  end if;

  -- (H) is_admin() keeps SECURITY DEFINER + a pinned search_path
  perform 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='is_admin' and p.prosecdef
     and exists (select 1 from unnest(p.proconfig) x where x ilike 'search_path=%');
  if not found then raise exception 'FAIL(H): is_admin() lost SECURITY DEFINER or its pinned search_path'; end if;

  raise notice 'PASS: read-only assertions A–H';
end $$;

-- (J) NEGATIVE TEST for the consistency gate — MANUAL, on a DISPOSABLE staging snapshot
--     (mutating; intentionally NOT in this read-only script):
--       1. Flag a spare non-admin user as app_metadata admin (not in user_roles/slab_admins).
--       2. Re-apply the migration; it MUST abort with SQLSTATE from RAISE and message
--          'ADMIN_UNIFY_ABORT: ...'.
--       3. Discard the snapshot.
--
-- (K) ROLE-CONTEXT — MANUAL, with real sessions on staging:
--       set role anon;  select public.is_current_user_admin();  -- expect: permission denied
--       reset role;
--     With an authenticated customer JWT: is_current_user_admin() -> false.
--     With the owner's JWT:               is_current_user_admin() -> true.
