-- ============================================================================
-- SlabVault — safe archival + controlled hard deletion.
--
-- Real inventory is ARCHIVED, never deleted: the row (and its inventory number,
-- comps, images, valuation history) is preserved and simply hidden from active
-- inventory. Inventory numbers are permanent and are never reused, so archiving
-- can never cause a number to be silently reassigned.
--
-- A SEPARATE, explicitly-confirmed hard delete exists ONLY for temporary test
-- records; it removes the comps and the slab row and returns the image paths so
-- the caller can delete the storage objects (and report partial failures).
-- ============================================================================

alter table public.slabs add column if not exists archived_at timestamptz;

create index if not exists slabs_archived_idx on public.slabs (archived_at);

-- ─── archive / unarchive (idempotent, admin-only) ───────────────────────────
create or replace function public.archive_slab(p_id uuid)
returns public.slabs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.slabs;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  update public.slabs
    set archived_at = coalesce(archived_at, now())
    where id = p_id
    returning * into v_row;
  if v_row.id is null then
    raise exception 'SLAB_NOT_FOUND' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

create or replace function public.unarchive_slab(p_id uuid)
returns public.slabs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.slabs;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  update public.slabs
    set archived_at = null
    where id = p_id
    returning * into v_row;
  if v_row.id is null then
    raise exception 'SLAB_NOT_FOUND' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

-- ============================================================================
-- hard_delete_slab: for temporary test records ONLY. Removes comps + the slab
-- row atomically and returns the image paths so the caller can delete the
-- storage objects. The inventory number is NOT recycled (numbering comes from a
-- monotonic sequence in a later migration; a deleted number simply becomes a
-- permanent gap).
-- ============================================================================
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

grant execute on function public.archive_slab(uuid)      to authenticated;
grant execute on function public.unarchive_slab(uuid)    to authenticated;
grant execute on function public.hard_delete_slab(uuid)  to authenticated;
