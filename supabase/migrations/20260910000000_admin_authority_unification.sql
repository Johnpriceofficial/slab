-- 20260910000000_admin_authority_unification.sql
--
-- F5 + G4, STEP 1 of a staged migration: make public.user_roles the single
-- canonical administrator authority. Compatibility-preserving; no legacy source
-- is dropped here. See release/evidence/admin-authority-unification-plan.md.
--
-- DECISION (owner): Option B — user_roles is canonical; auth app_metadata is a
-- non-authoritative compatibility cache / UI hint; slab_admins staged for deprecation.
--
-- BACKFILL POLICY (hardened): app_metadata is NOT trusted as a backfill source.
-- The canonical set is seeded ONLY from (existing user_roles administrators) ∪
-- (the explicit slab_admins allowlist). app_metadata is used solely as a
-- CONSISTENCY GATE: if any account is flagged admin in app_metadata but is not
-- represented in either trusted source, the migration ABORTS for manual owner
-- review rather than silently laundering unreviewed JWT metadata into canonical
-- administrator status.
--
-- ORDERING: apply ONLY AFTER the migration-ledger reconciliation (F4). This file
-- has NOT been applied to any environment. Draft PR — do not merge/apply.
-- No emails or secret data are stored in this migration.
--
-- DEPLOYED-SCHEMA BASIS: is_admin(uuid) is the ONLY function reading app_metadata;
-- 44 RLS policies call is_admin(), 8 call has_role() (already user_roles-backed);
-- no function/runtime code reads slab_admins; every Edge guard and the frontend
-- funnel through is_admin(). Repointing is_admin() at user_roles + this backfill
-- makes all 52 admin policies consistent from one source, nothing else changed.

begin;

-- 1) Existing user_roles('administrator') rows are preserved untouched (this
--    migration only inserts; it never updates or deletes user_roles).

-- 2) Backfill the EXPLICIT admin allowlist (public.slab_admins) into user_roles.
--    Idempotent via the (user_id, role) unique key. app_metadata is intentionally
--    NOT a source here.
insert into public.user_roles (user_id, role)
select distinct sa.user_id, 'administrator'::public.app_role
  from public.slab_admins sa
 where sa.user_id is not null
on conflict (user_id, role) do nothing;

-- 3) CONSISTENCY GATE (runs BEFORE is_admin() is repointed). app_metadata is not an
--    authorization input: any account flagged admin there but absent from both
--    user_roles('administrator') and slab_admins is unexpected (stale or accidental
--    elevation) and aborts the whole transaction for manual review.
do $$
declare
  v_unexpected integer;
begin
  select count(*)
    into v_unexpected
    from auth.users u
   where coalesce((u.raw_app_meta_data->>'graded_card_value_admin')::boolean, false)
     and not exists (
       select 1 from public.user_roles ur
        where ur.user_id = u.id and ur.role = 'administrator')
     and not exists (
       select 1 from public.slab_admins sa
        where sa.user_id = u.id);
  if v_unexpected > 0 then
    raise exception
      'ADMIN_UNIFY_ABORT: % app_metadata administrator account(s) are not represented in user_roles or slab_admins. Add legitimate admins to slab_admins (or user_roles) after review, then re-run; app_metadata is not auto-promoted.',
      v_unexpected
      using errcode = 'raise_exception';
  end if;
end $$;

-- 4) CANONICAL SOURCE — is_admin() now derives from user_roles only. Signature,
--    volatility, SECURITY DEFINER, search_path and EXECUTE grants are unchanged, so
--    all 44 is_admin RLS policies, every RPC, and every Edge guard keep working and
--    are now user_roles-sourced. app_metadata is no longer read for authorization.
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

-- 5) SELF-SCOPED helpers (G4, PARTIAL) — clients must never pass an arbitrary
--    user_id. These read only the caller's own identity. Migrating callers to them
--    and revoking the arbitrary-user variants is explicitly STAGED (see the plan);
--    role enumeration is NOT fully closed by this migration.
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

-- STAGED (later migrations; NOT done here — see the plan doc):
--   * migrate the 44 is_admin RLS policies to is_current_user_admin() (where they
--     pass auth.uid()), and the frontend AuthProvider to rpc('is_current_user_admin').
--   * ONLY THEN revoke arbitrary-user is_admin(uuid)/has_role(uuid,app_role) EXECUTE
--     from authenticated + anon (keep service_role) — this is what actually closes
--     role enumeration (G4). It CANNOT be done here or RLS is_admin(auth.uid()) breaks.
--   * deprecate then drop public.slab_admins (route writes through scoped RPCs first).
--   * collapse redundant app_role 'admin' vs 'administrator'.
