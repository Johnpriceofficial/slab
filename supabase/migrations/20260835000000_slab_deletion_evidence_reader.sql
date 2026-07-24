-- Keep the private schema unexposed while allowing authorized administrators to
-- verify immutable deletion evidence through a narrow, audited RPC contract.

create or replace function public.get_slab_deletion_tombstone(p_slab_id uuid)
returns table (
  slab_id uuid,
  owner_id uuid,
  inventory_number integer,
  inventory_code text,
  card_name text,
  grader text,
  grade text,
  certification_number text,
  deleted_by uuid,
  deleted_at timestamptz,
  reason text
)
language plpgsql
security definer
stable
set search_path = public, private, auth
as $$
begin
  if not public.is_admin((select auth.uid())) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  return query
  select t.slab_id,
         t.owner_id,
         t.inventory_number,
         t.inventory_code,
         t.card_name,
         t.grader,
         t.grade,
         t.certification_number,
         t.deleted_by,
         t.deleted_at,
         t.reason
    from private.slab_deletion_tombstones t
   where t.slab_id = p_slab_id;
end;
$$;

revoke all on function public.get_slab_deletion_tombstone(uuid) from public, anon;
grant execute on function public.get_slab_deletion_tombstone(uuid) to authenticated;

comment on function public.get_slab_deletion_tombstone(uuid) is
  'Admin-only reader for immutable break-glass slab deletion evidence; private tables remain unavailable through the Data API.';
