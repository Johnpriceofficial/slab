-- ============================================================================
-- GradedCardValue.com — administrative slab cleanup and public-ID maintenance.
--
-- The internal slabs.inventory_number remains immutable because it keys storage
-- paths and marketplace integrations. Administrators may correct the visible
-- S0001-style inventory_sequence through guarded RPCs. Permanent deletion is
-- transactionally atomic inside Postgres; storage objects are deleted through
-- the Storage API and every pending path is durably tracked until acknowledged.
-- ============================================================================

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

create table if not exists private.slab_storage_cleanup_queue (
  bucket_id text not null default 'slab-images',
  storage_path text primary key,
  slab_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text
);

revoke all on table private.slab_storage_cleanup_queue from public, anon, authenticated;

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

  perform pg_advisory_xact_lock(918273646);

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
  v_offset integer;
begin
  if not public.is_admin((select auth.uid())) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(918273646);
  perform set_config('app.inventory_maintenance', 'on', true);
  select coalesce(max(inventory_sequence), 0) + 1 into v_offset from public.slabs;

  -- Shift every existing sequence up first so the renumber below can assign
  -- 1..N without transiently colliding with a not-yet-renumbered row. The
  -- WHERE clause is required: this environment rejects WHERE-less UPDATEs, and
  -- every slab carries a non-null inventory_sequence, so this still covers all.
  update public.slabs
     set inventory_sequence = inventory_sequence + v_offset
   where inventory_sequence is not null;

  with ordered as (
    select id, row_number() over (
      order by inventory_sequence, created_at, id
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
declare
  v_requested integer;
  v_found integer;
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

  perform pg_advisory_xact_lock(918273646);

  select count(*) into v_requested from (select distinct unnest(p_ids) as id) requested;
  select count(*) into v_found from public.slabs where id = any(p_ids);
  if v_found <> v_requested then
    raise exception 'SLAB_NOT_FOUND_OR_DUPLICATE_INPUT' using errcode = 'P0002';
  end if;

  insert into private.slab_storage_cleanup_queue (storage_path, slab_id)
  select queued.path, queued.slab_id
  from (
    select s.id as slab_id, s.front_image_path as path from public.slabs s where s.id = any(p_ids)
    union all
    select s.id as slab_id, s.back_image_path as path from public.slabs s where s.id = any(p_ids)
  ) queued
  where queued.path is not null and btrim(queued.path) <> ''
  on conflict (storage_path) do update
    set slab_id = excluded.slab_id,
        updated_at = now();

  return query
    select s.id, s.front_image_path, s.back_image_path
    from public.slabs s
    where s.id = any(p_ids)
    order by s.id;

  -- Qualify slab_id with the table name: the function's RETURNS TABLE(slab_id …)
  -- output column is an in-scope variable and would otherwise be ambiguous (42702).
  delete from private.ebay_order_line_items where ebay_order_line_items.slab_id = any(p_ids);
  delete from public.marketplace_events where marketplace_events.slab_id = any(p_ids);
  delete from public.sold_comps where sold_comps.slab_id = any(p_ids);
  delete from public.audit_log
   where (entity_type = 'slab' and entity_id = any(select x::text from unnest(p_ids) x))
      or detail->>'slab_id' = any(select x::text from unnest(p_ids) x);

  delete from public.slabs where id = any(p_ids);
end;
$$;

revoke all on function public.purge_slabs(uuid[]) from public, anon;
grant execute on function public.purge_slabs(uuid[]) to authenticated;

-- Compatibility entry point used by the detail-page test-record action. Keeping
-- the existing signature avoids a parallel implementation while ensuring every
-- destructive path uses the same transaction, authorization, gate, and queue.
create or replace function public.hard_delete_slab(p_id uuid)
returns table (front_image_path text, back_image_path text)
language sql
security invoker
set search_path = public
as $$
  select p.front_image_path, p.back_image_path
  from public.purge_slabs(array[p_id]) p;
$$;

revoke all on function public.hard_delete_slab(uuid) from public, anon;
grant execute on function public.hard_delete_slab(uuid) to authenticated;

create or replace function public.list_pending_slab_storage_cleanup()
returns table (storage_path text)
language plpgsql
security definer
set search_path = public, private, auth
as $$
begin
  if not public.is_admin((select auth.uid())) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  return query
    select q.storage_path
    from private.slab_storage_cleanup_queue q
    order by q.created_at, q.storage_path;
end;
$$;

create or replace function public.acknowledge_slab_storage_cleanup(p_paths text[])
returns integer
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  v_count integer;
begin
  if not public.is_admin((select auth.uid())) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_paths is null or cardinality(p_paths) = 0 then
    return 0;
  end if;
  delete from private.slab_storage_cleanup_queue where storage_path = any(p_paths);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.record_slab_storage_cleanup_failure(p_paths text[], p_error text)
returns integer
language plpgsql
security definer
set search_path = public, private, auth
as $$
declare
  v_count integer;
begin
  if not public.is_admin((select auth.uid())) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_paths is null or cardinality(p_paths) = 0 then
    return 0;
  end if;
  update private.slab_storage_cleanup_queue
     set attempts = attempts + 1,
         last_error = left(coalesce(p_error, 'Unknown Storage API failure'), 2000),
         updated_at = now()
   where storage_path = any(p_paths);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.list_pending_slab_storage_cleanup() from public, anon;
revoke all on function public.acknowledge_slab_storage_cleanup(text[]) from public, anon;
revoke all on function public.record_slab_storage_cleanup_failure(text[], text) from public, anon;
grant execute on function public.list_pending_slab_storage_cleanup() to authenticated;
grant execute on function public.acknowledge_slab_storage_cleanup(text[]) to authenticated;
grant execute on function public.record_slab_storage_cleanup_failure(text[], text) to authenticated;

comment on function public.reassign_slab_inventory_id(uuid, integer) is
  'Admin-only correction of the visible S-number. Internal inventory_number is unchanged.';
comment on function public.compact_slab_inventory_ids() is
  'Admin-only serialized renumbering of all remaining visible slab IDs to S0001..S00NN.';
comment on function public.purge_slabs(uuid[]) is
  'Admin-only transactional database purge. Storage paths are queued durably for Storage API deletion and retry.';
comment on function public.hard_delete_slab(uuid) is
  'Compatibility wrapper around purge_slabs for the detail-page test-record action.';
