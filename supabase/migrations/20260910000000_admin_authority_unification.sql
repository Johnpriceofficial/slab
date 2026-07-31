-- 20260910000000_admin_authority_unification.sql
--
-- F5 + G4, STEP 1 of a staged migration: make public.user_roles the single
-- canonical administrator authority. Compatibility-preserving; no legacy source
-- is dropped here. See release/evidence/admin-authority-unification-plan.md.
--
-- DECISION (owner): Option B — user_roles is canonical; auth app_metadata is
-- demoted to a non-authoritative compatibility cache / UI hint; slab_admins is
-- staged for deprecation.
--
-- ORDERING: apply ONLY AFTER the migration-ledger reconciliation (F4). This file
-- has NOT been applied to any environment. Draft PR — do not merge/apply.
--
-- WHY THIS IS SAFE / COMPLETE FOR THE DB LAYER:
--   * The deployed schema was audited: public.is_admin(uuid) is the ONLY function
--     that reads raw_app_meta_data. 44 RLS policies call is_admin(); 8 call
--     has_role() (already user_roles-backed). No function reads slab_admins; no
--     runtime code reads has_role/slab_admins. Every Edge Function checks admin via
--     isCallerAdmin() -> is_admin() (service role). The frontend gate calls
--     is_admin() by RPC.
--   * Therefore repointing is_admin() at user_roles + backfilling every current
--     admin into user_roles makes ALL 52 admin policies + every RPC + every Edge
--     guard consistent from ONE source, with no other DB object changed.

begin;

-- 1) BACKFILL — every current administrator (by any legacy source) becomes a
--    user_roles('administrator') row. Idempotent (unique on user_id, role).
--    Current state at authoring time: app_metadata admins = {owner, test-admin};
--    slab_admins = {owner}; user_roles administrators = {test-admin}. After this:
--    user_roles administrators = {owner, test-admin}.
insert into public.user_roles (user_id, role)
select distinct u.id, 'administrator'::public.app_role
  from auth.users u
 where coalesce((u.raw_app_meta_data->>'graded_card_value_admin')::boolean, false)
    or exists (select 1 from public.slab_admins sa where sa.user_id = u.id)
on conflict (user_id, role) do nothing;

-- 2) CANONICAL SOURCE — is_admin() now derives authority from user_roles only.
--    Signature, volatility, SECURITY DEFINER, search_path and EXECUTE grants are
--    unchanged, so all 44 is_admin RLS policies, every RPC, and every Edge guard
--    keep working and are now user_roles-sourced. app_metadata is no longer read.
create or replace function public.is_admin(_user_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path to 'public'
as $$
  select exists (
    select 1
      from public.user_roles ur
     where ur.user_id = _user_id
       and ur.role = 'administrator'
  );
$$;

-- 3) SELF-SCOPED helpers (G4) — clients must never pass an arbitrary user_id.
--    The frontend admin gate and any browser role check move to these; they read
--    only the caller's own identity, removing the role-enumeration surface.
create or replace function public.is_current_user_admin()
  returns boolean
  language sql
  stable
  security definer
  set search_path to 'public'
as $$
  select public.is_admin((select auth.uid()));
$$;

create or replace function public.current_user_has_role(_role public.app_role)
  returns boolean
  language sql
  stable
  security definer
  set search_path to 'public'
as $$
  select public.has_role((select auth.uid()), _role);
$$;

revoke all on function public.is_current_user_admin()                from public, anon;
revoke all on function public.current_user_has_role(public.app_role) from public, anon;
grant execute on function public.is_current_user_admin()                to authenticated;
grant execute on function public.current_user_has_role(public.app_role) to authenticated;

commit;

-- NOT done here (staged — later migrations, after callers move to the self-scoped
-- helpers and the ledger/behaviour is proven on staging):
--   * REVOKE arbitrary-user is_admin(uuid)/has_role(uuid,app_role) EXECUTE from
--     authenticated (blocked until all 52 policies + the frontend use the
--     self-scoped variants, else is_admin(auth.uid()) in RLS loses EXECUTE).
--   * migrate the frontend AuthProvider from rpc('is_admin',{_user_id}) to
--     rpc('is_current_user_admin') (slab-scribe-pro repo).
--   * deprecate then drop public.slab_admins (migrate its admin-list writes to
--     scoped RPCs / trusted server ops, then revoke authenticated DML, then drop).
--   * collapse the redundant app_role 'admin' vs 'administrator' values.
