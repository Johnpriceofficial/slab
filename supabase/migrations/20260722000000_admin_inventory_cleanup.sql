-- ============================================================================
-- GradedCardValue.com — administrative slab cleanup and public-ID maintenance.
--
-- The internal slabs.inventory_number remains immutable because it keys storage
-- paths and marketplace integrations. Administrators may correct the visible
-- S0001-style inventory_sequence through guarded RPCs. Archived/test records may
-- be purged with their database references; storage objects are removed by the
-- client from the paths returned by purge_slabs().
-- ============================================================================

-- Permit the inventory immutability trigger only while a guarded maintenance RPC
-- has enabled a transaction-local flag. Direct table updates remain blocked.
create or replace function public.enforce_inventory_id_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.inventory_prefix is distinct from old.inventory_prefix
     or new.inventory_sequence is distinct from old.inventory_sequence then
    if current_setting('app.inventory_maintenance', true) is distinct from 'on' then
      raise exception 'INVENTORY_ID_IMMUTABLE: use an administrative inventory maintenance function'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.reassign_slab_inventory_id(
  p_slab_id uuid,
  p_sequence integer
)
returns public.slabs
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_row public.slabs;
begin
  if not public.is_admin((select auth.uid())) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_sequence is null or p_sequence < 1 then
    raise exception 'INVALID_INVENTORY_SEQUENCE' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.slabs
    where inventory_prefix = 'S'
      and inventory_sequence = p_sequence
      and id <> p_slab_id
  ) then
    raise exception 'INVENTORY_ID_ALREADY_USED' using errcode = '23505';
  end if;

  perform set_config('app.inventory_maintenance', 'on', true);
  update public.slabs
     set inventory_prefix = 'S', inventory_sequence = p_sequence
   where id = p_slab_id
   returning * into v_row;
  perform set_config('app.inventory_maintenance', 'off', true);

  if v_row.id is null then
    raise exception 'SLAB_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform setval(
    'public.slab_public_seq',
    greatest(
      coalesce((select max(inventory_sequence) from public.slabs where inventory_prefix = 'S'), 0) + 1,
      1
    ),
    false
  );
  return v_row;
end;
$$;

revoke all on function public.reassign_slab_inventory_id(uuid, integer) from public, anon;
grant execute on function public.reassign_slab_inventory_id(uuid, integer) to authenticated;

create or replace function public.compact_slab_inventory_ids()
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_count integer;
begin
  if not public.is_admin((select auth.uid())) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(918273646);
  perform set_config('app.inventory_maintenance', 'on', true);

  -- Move all current sequences out of the positive keyspace first so the unique
  -- index cannot collide while assigning the compact 1..N sequence.
  update public.slabs set inventory_sequence = -inventory_sequence;

  with ordered as (
    select id, row_number() over (
      order by abs(inventory_sequence), created_at, id
    )::integer as next_sequence
    from public.slabs
  )
  update public.slabs s
     set inventory_prefix = 'S', inventory_sequence = o.next_sequence
    from ordered o
   where o.id = s.id;

  get diagnostics v_count = row_count;
  perform set_config('app.inventory_maintenance', 'off', true);
  perform setval('public.slab_public_seq', greatest(v_count + 1, 1), false);
  return v_count;
end;
$$;

revoke all on function public.compact_slab_inventory_ids() from public, anon;
grant execute on function public.compact_slab_inventory_ids() to authenticated;

create or replace function public.purge_slabs(p_ids uuid[])
returns table (
  slab_id uuid,
  front_image_path text,
  back_image_path text
)
language plpgsql
security definer
set search_path = public, private, auth
as $$
begin
  if not public.is_admin((select auth.uid())) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then
    raise exception 'NO_SLABS_SELECTED' using errcode = '22023';
  end if;
  if not coalesce((select allow_hard_delete from public.slab_settings where id = true), false) then
    raise exception 'HARD_DELETE_DISABLED' using errcode = '42501';
  end if;

  -- Return storage paths before deleting rows. The browser removes the private
  -- objects after this transaction commits and reports any orphan cleanup error.
  return query
    select s.id, s.front_image_path, s.back_image_path
    from public.slabs s
    where s.id = any(p_ids);

  -- Remove references that otherwise preserve a trace through SET NULL FKs or
  -- non-FK entity identifiers. CASCADE relationships are removed with slabs.
  delete from private.ebay_order_line_items where slab_id = any(p_ids);
  delete from public.marketplace_events where slab_id = any(p_ids);
  delete from public.sold_comps where slab_id = any(p_ids);
  delete from public.audit_log
   where (entity_type = 'slab' and entity_id = any(select x::text from unnest(p_ids) x))
      or detail->>'slab_id' = any(select x::text from unnest(p_ids) x);

  delete from public.slabs where id = any(p_ids);
end;
$$;

revoke all on function public.purge_slabs(uuid[]) from public, anon;
grant execute on function public.purge_slabs(uuid[]) to authenticated;

comment on function public.reassign_slab_inventory_id(uuid, integer) is
  'Admin-only correction of the visible S-number. Internal inventory_number is unchanged.';
comment on function public.compact_slab_inventory_ids() is
  'Admin-only renumbering of all remaining visible slab IDs to S0001..S00NN.';
comment on function public.purge_slabs(uuid[]) is
  'Admin-only permanent database purge. Returns storage paths for post-commit object deletion.';
