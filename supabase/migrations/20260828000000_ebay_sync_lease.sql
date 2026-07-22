-- ============================================================================
-- PR C.8: single-flight sync lease. Prevents two order syncs (or two finance
-- syncs) for the SAME account+resource from running concurrently — a second
-- caller gets sync_in_progress with no provider reads or durable writes. Lives in
-- the private (deny-all, service-role-only) schema, mirroring the publish lease.
-- ============================================================================

create table if not exists private.ebay_sync_leases (
  id uuid primary key default gen_random_uuid(),
  ebay_account_id uuid not null references public.ebay_accounts(id) on delete cascade,
  resource_type text not null,
  lease_token text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (ebay_account_id, resource_type)
);
revoke all on table private.ebay_sync_leases from public, anon, authenticated;
alter table private.ebay_sync_leases enable row level security;

create or replace function public.ebay_sync_lease_acquire(p_account_id uuid, p_resource_type text, p_token text, p_ttl_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_expires timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text || '|sync|' || coalesce(p_resource_type, ''), 0));
  select expires_at into v_expires from private.ebay_sync_leases where ebay_account_id = p_account_id and resource_type = p_resource_type;
  if found and v_expires > v_now then
    return jsonb_build_object('acquired', false);
  end if;
  insert into private.ebay_sync_leases (ebay_account_id, resource_type, lease_token, acquired_at, expires_at)
  values (p_account_id, p_resource_type, p_token, v_now, v_now + make_interval(secs => greatest(1, p_ttl_seconds)))
  on conflict (ebay_account_id, resource_type) do update
    set lease_token = excluded.lease_token, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at;
  return jsonb_build_object('acquired', true);
end;
$$;
revoke all on function public.ebay_sync_lease_acquire(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.ebay_sync_lease_acquire(uuid, text, text, integer) to service_role;

create or replace function public.ebay_sync_lease_release(p_account_id uuid, p_resource_type text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare v_deleted integer;
begin
  delete from private.ebay_sync_leases where ebay_account_id = p_account_id and resource_type = p_resource_type and lease_token = p_token;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('released', v_deleted = 1);
end;
$$;
revoke all on function public.ebay_sync_lease_release(uuid, text, text) from public, anon, authenticated;
grant execute on function public.ebay_sync_lease_release(uuid, text, text) to service_role;
