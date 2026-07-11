-- ============================================================================
-- SlabVault — server-side guard for the test-only hard delete.
--
-- Archival is the standard, always-available action. Hard deletion is for
-- temporary test records ONLY and must not be usable casually in production.
-- This adds an AUTHORITATIVE server-side gate: hard_delete_slab refuses unless
-- an admin has explicitly enabled it in public.slab_settings. The frontend
-- additionally hides the hard-delete UI in production builds (defense in depth),
-- but the DB gate is the real control — a direct RPC call is still blocked.
-- ============================================================================

create table if not exists public.slab_settings (
  id                boolean primary key default true,
  allow_hard_delete boolean not null default false,
  updated_at        timestamptz not null default now(),
  constraint slab_settings_singleton check (id)
);

-- Exactly one row.
insert into public.slab_settings (id) values (true) on conflict (id) do nothing;

alter table public.slab_settings enable row level security;
drop policy if exists "slab_settings admin all" on public.slab_settings;
create policy "slab_settings admin all" on public.slab_settings
  for all to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- ─── hard_delete_slab: now gated on slab_settings.allow_hard_delete ──────────
create or replace function public.hard_delete_slab(p_id uuid)
returns table (front_image_path text, back_image_path text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_front text;
  v_back  text;
  v_found boolean;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  -- Authoritative gate: hard delete is disabled unless explicitly enabled.
  if not coalesce((select allow_hard_delete from public.slab_settings limit 1), false) then
    raise exception 'HARD_DELETE_DISABLED' using errcode = '42501';
  end if;

  select s.front_image_path, s.back_image_path, true
    into v_front, v_back, v_found
    from public.slabs s
    where s.id = p_id;

  if not coalesce(v_found, false) then
    raise exception 'SLAB_NOT_FOUND' using errcode = 'P0002';
  end if;

  delete from public.slab_comps where slab_id = p_id;
  delete from public.slabs where id = p_id;

  front_image_path := v_front;
  back_image_path := v_back;
  return next;
end;
$$;

grant execute on function public.hard_delete_slab(uuid) to authenticated;
