-- ============================================================================
-- SlabVault admin model — SELF-CONTAINED.
-- The monorepo provided public.is_admin(uuid) via its own roles system. A
-- dedicated SlabVault project has none, so we define a minimal equivalent here
-- so every downstream migration (RLS, create_slab) and the edge function's
-- admin check resolve. Admins are an explicit allowlist of auth user ids.
--
-- BOOTSTRAP (one time, after you sign up in the app / dashboard):
--   1. Find your user id:   select id, email from auth.users;
--   2. Grant yourself admin: insert into public.slab_admins (user_id)
--                            values ('<your-user-id>');
-- Until a row exists here, NO ONE can read or write slabs — that is intentional.
-- ============================================================================

create table if not exists public.slab_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- is_admin(uuid): true only for user ids explicitly listed in slab_admins.
-- SECURITY DEFINER so it can read slab_admins under any caller's RLS context.
create or replace function public.is_admin(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.slab_admins a where a.user_id = _user_id
  );
$$;

grant execute on function public.is_admin(uuid) to authenticated, anon;

-- Only existing admins may view / manage the admin allowlist.
alter table public.slab_admins enable row level security;

drop policy if exists "slab_admins admin all" on public.slab_admins;
create policy "slab_admins admin all" on public.slab_admins
  for all to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));
