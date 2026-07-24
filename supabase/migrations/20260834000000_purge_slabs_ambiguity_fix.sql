-- Resolve PL/pgSQL output-column ambiguity in purge_slabs without weakening
-- deletion safety, audit retention, storage cleanup coverage, or authorization.
--
-- RETURNS TABLE exposes slab_id/front_image_path/back_image_path as PL/pgSQL
-- variables. Prefer relation columns whenever a SQL statement uses the same
-- names, and use named conflict constraints for deterministic resolution.

create or replace function public.purge_slabs(p_ids uuid[])
returns table (slab_id uuid, front_image_path text, back_image_path text)
language plpgsql
security definer
set search_path = public, private, storage, auth
as $$
#variable_conflict use_column
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

  select count(*)
    into v_requested
    from (select distinct unnest(p_ids) as id) requested;

  select count(*)
    into v_found
    from public.slabs s
   where s.id = any(p_ids);

  if v_found <> v_requested then
    raise exception 'SLAB_NOT_FOUND_OR_DUPLICATE_INPUT' using errcode = 'P0002';
  end if;

  insert into private.slab_deletion_tombstones (
    slab_id, owner_id, inventory_number, inventory_code, card_name, grader, grade,
    certification_number, deleted_by, deleted_at
  )
  select s.id, s.owner_id, s.inventory_number, s.inventory_code, s.card_name,
         s.grader, s.grade, s.certification_number, (select auth.uid()), now()
    from public.slabs s
   where s.id = any(p_ids)
  on conflict on constraint slab_deletion_tombstones_pkey do nothing;

  insert into public.audit_log (
    actor_user_id, action, entity_type, entity_id, source, detail, owner_id
  )
  select (select auth.uid()), 'hard_delete', 'slab', s.id::text, 'admin_rpc',
         jsonb_build_object(
           'slab_id', s.id,
           'inventory_number', s.inventory_number,
           'inventory_code', s.inventory_code,
           'storage_cleanup_queued', true
         ),
         s.owner_id
    from public.slabs s
   where s.id = any(p_ids);

  insert into private.slab_storage_cleanup_queue (storage_path, slab_id)
  select distinct paths.storage_path, paths.source_slab_id
    from (
      select s.front_image_path as storage_path, s.id as source_slab_id
        from public.slabs s
       where s.id = any(p_ids)
      union all
      select s.back_image_path, s.id
        from public.slabs s
       where s.id = any(p_ids)
      union all
      select si.storage_path, si.slab_id
        from public.slab_images si
       where si.slab_id = any(p_ids)
      union all
      select d.storage_path, si.slab_id
        from public.image_derivatives d
        join public.slab_images si on si.id = d.slab_image_id
       where si.slab_id = any(p_ids)
      union all
      select o.name, s.id
        from storage.objects o
        join public.slabs s
          on split_part(o.name, '/', 1) = 'slabs'
         and split_part(o.name, '/', 2) = s.inventory_number::text
       where o.bucket_id = 'slab-images'
         and s.id = any(p_ids)
    ) paths
   where nullif(btrim(paths.storage_path), '') is not null
  on conflict on constraint slab_storage_cleanup_queue_pkey
  do update
        set slab_id = excluded.slab_id,
            updated_at = now();

  return query
  select s.id, s.front_image_path, s.back_image_path
    from public.slabs s
   where s.id = any(p_ids)
   order by s.id;

  delete from private.ebay_order_line_items li
   where li.slab_id = any(p_ids);
  delete from public.marketplace_events me
   where me.slab_id = any(p_ids);
  delete from public.sold_comps sc
   where sc.slab_id = any(p_ids);

  -- audit_log and slab_deletion_tombstones are intentionally retained.
  delete from public.slabs s
   where s.id = any(p_ids);
end;
$$;

revoke all on function public.purge_slabs(uuid[]) from public, anon;
grant execute on function public.purge_slabs(uuid[]) to authenticated;

comment on function public.purge_slabs(uuid[]) is
  'Admin-only break-glass purge. Retains audit/tombstone evidence and durably queues every known storage object for deletion.';
