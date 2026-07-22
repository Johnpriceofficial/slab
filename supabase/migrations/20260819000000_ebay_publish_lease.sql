-- ============================================================================
-- PR C.6: race-safe publish. A durable per-(account, SKU) publish LEASE closes
-- the check-then-create race in the publish path (two concurrent publishes could
-- each see zero offers and each POST a new offer). Acquisition is atomic under an
-- advisory xact lock (mirrors the OAuth single-flight): only one active lease may
-- exist per account+SKU; a second caller gets acquired=false → publish_in_progress.
-- Expired leases are reclaimable. service_role only.
-- ============================================================================

create table if not exists public.ebay_publish_leases (
  id uuid primary key default gen_random_uuid(),
  ebay_account_id uuid not null references public.ebay_accounts(id) on delete cascade,
  sku text not null,
  lease_token text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (ebay_account_id, sku)
);
alter table public.ebay_publish_leases enable row level security;
create policy ebay_publish_leases_admin_all on public.ebay_publish_leases
  for all to authenticated using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));
grant select, insert, update, delete on public.ebay_publish_leases to authenticated;
grant all on public.ebay_publish_leases to service_role;

-- Atomic acquire: serialize concurrent callers for the SAME account+SKU under an
-- advisory xact lock, then grant the lease only if none is currently active.
create or replace function public.ebay_publish_lease_acquire(p_account_id uuid, p_sku text, p_token text, p_ttl_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_expires timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text || '|' || coalesce(p_sku, ''), 0));
  select expires_at into v_expires from public.ebay_publish_leases where ebay_account_id = p_account_id and sku = p_sku;
  if found and v_expires > v_now then
    return jsonb_build_object('acquired', false);
  end if;
  insert into public.ebay_publish_leases (ebay_account_id, sku, lease_token, acquired_at, expires_at)
  values (p_account_id, p_sku, p_token, v_now, v_now + make_interval(secs => greatest(1, p_ttl_seconds)))
  on conflict (ebay_account_id, sku) do update
    set lease_token = excluded.lease_token, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at;
  return jsonb_build_object('acquired', true, 'token', p_token);
end;
$$;
revoke all on function public.ebay_publish_lease_acquire(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.ebay_publish_lease_acquire(uuid, text, text, integer) to service_role;

-- Release only if this caller still holds the lease (token match).
create or replace function public.ebay_publish_lease_release(p_account_id uuid, p_sku text, p_token text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.ebay_publish_leases where ebay_account_id = p_account_id and sku = p_sku and lease_token = p_token;
end;
$$;
revoke all on function public.ebay_publish_lease_release(uuid, text, text) from public, anon, authenticated;
grant execute on function public.ebay_publish_lease_release(uuid, text, text) to service_role;
