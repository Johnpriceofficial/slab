-- =====================================================================
-- Authority foundation (canonicalized from frontend backend-patch
-- 20260729-user-roles-foundation). Creates app_role / user_roles / has_role
-- that PR #94 (20260909) and PR #95 (20260910) both REFERENCE but neither
-- CREATES. Placed before them in the canonical chain (D-5 resolution).
-- =====================================================================

begin;

-- 1. Role enum -----------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type public.app_role as enum ('administrator', 'customer');
  end if;
end
$$;

-- Additive label backfill (no-ops when the label already exists).
alter type public.app_role add value if not exists 'administrator';
alter type public.app_role add value if not exists 'customer';
-- Older patches in this repo reference 'admin'; keep the label available so
-- those policies compile against the same enum.
alter type public.app_role add value if not exists 'admin';

commit;

-- New enum labels are not usable in the same transaction that added them.
begin;

-- 2. Role table ----------------------------------------------------------
create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

create index if not exists user_roles_user_id_idx on public.user_roles (user_id);

-- 3. Grants (PostgREST needs explicit privileges) ------------------------
revoke all on public.user_roles from anon;
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;

-- 4. RLS ------------------------------------------------------------------
alter table public.user_roles enable row level security;

drop policy if exists "user_roles_select_own" on public.user_roles;
create policy "user_roles_select_own"
  on public.user_roles
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Role grants/revocations are service-role only (server-side, audited).
-- No insert/update/delete policy is created for `authenticated` on purpose.

-- 5. has_role() ------------------------------------------------------------
create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles
    where user_id = _user_id
      and role = _role
  );
$$;

revoke all on function public.has_role(uuid, public.app_role) from public;
grant execute on function public.has_role(uuid, public.app_role) to authenticated, service_role;

commit;

-- =============================================================================
-- Post-apply: grant staff access to the administrator test account.
-- Run separately, replacing the email, once the migration succeeds.
--
--   insert into public.user_roles (user_id, role)
--   select id, 'administrator'::public.app_role
--   from auth.users
--   where email = 'test+admin@gradedcardvalue.com'
--   on conflict (user_id, role) do nothing;
--
-- Precondition re-check (must return false, not an error):
--   select public.has_role('00000000-0000-0000-0000-000000000000'::uuid,
--                          'administrator'::public.app_role);
-- =============================================================================
