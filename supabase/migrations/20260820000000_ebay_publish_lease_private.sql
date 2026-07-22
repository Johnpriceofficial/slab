-- ============================================================================
-- PR C.6.1: move the publish lease into the PRIVATE (deny-all, service-role-only)
-- schema. The 20260819 table was created in `public` with an authenticated-admin
-- RLS policy and direct table grants — so an authenticated admin could read,
-- modify, or TRUNCATE a synchronization/locking table. A lease is server-only
-- infrastructure and must not be reachable through the Data API at all.
--
-- Also adds lease FENCING (assert-and-extend) so a long publish cannot silently
-- continue after its lease expired or was superseded, and makes release report
-- whether it actually deleted the caller's row.
--
-- Production holds ZERO lease rows, so dropping the public table is safe.
-- ============================================================================

drop function if exists public.ebay_publish_lease_acquire(uuid, text, text, integer);
drop function if exists public.ebay_publish_lease_release(uuid, text, text);
drop table if exists public.ebay_publish_leases cascade;

create table if not exists private.ebay_publish_leases (
  id uuid primary key default gen_random_uuid(),
  ebay_account_id uuid not null references public.ebay_accounts(id) on delete cascade,
  sku text not null,
  lease_token text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (ebay_account_id, sku)
);
-- Deny-all: the private schema is not exposed to PostgREST, and no client role
-- has any privilege. Only the function owner (service role) reaches it via the
-- SECURITY DEFINER RPCs below.
revoke all on table private.ebay_publish_leases from public, anon, authenticated;

-- Atomic acquire: serialize concurrent callers for the SAME account+SKU under an
-- advisory xact lock, then grant only if none is currently active.
create or replace function public.ebay_publish_lease_acquire(p_account_id uuid, p_sku text, p_token text, p_ttl_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_expires timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text || '|' || coalesce(p_sku, ''), 0));
  select expires_at into v_expires from private.ebay_publish_leases where ebay_account_id = p_account_id and sku = p_sku;
  if found and v_expires > v_now then
    return jsonb_build_object('acquired', false);
  end if;
  insert into private.ebay_publish_leases (ebay_account_id, sku, lease_token, acquired_at, expires_at)
  values (p_account_id, p_sku, p_token, v_now, v_now + make_interval(secs => greatest(1, p_ttl_seconds)))
  on conflict (ebay_account_id, sku) do update
    set lease_token = excluded.lease_token, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at;
  return jsonb_build_object('acquired', true, 'token', p_token);
end;
$$;
revoke all on function public.ebay_publish_lease_acquire(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.ebay_publish_lease_acquire(uuid, text, text, integer) to service_role;

-- Fencing: prove THIS caller still owns a non-expired lease and atomically extend
-- it. held=false means the lease was lost/superseded — the caller must abort
-- before any further provider mutation. Never reveals another caller's token.
create or replace function public.ebay_publish_lease_assert_and_extend(p_account_id uuid, p_sku text, p_token text, p_ttl_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_updated integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text || '|' || coalesce(p_sku, ''), 0));
  update private.ebay_publish_leases
     set expires_at = v_now + make_interval(secs => greatest(1, p_ttl_seconds))
   where ebay_account_id = p_account_id and sku = p_sku and lease_token = p_token and expires_at > v_now;
  get diagnostics v_updated = row_count;
  return jsonb_build_object('held', v_updated = 1);
end;
$$;
revoke all on function public.ebay_publish_lease_assert_and_extend(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.ebay_publish_lease_assert_and_extend(uuid, text, text, integer) to service_role;

-- Release only the caller's own lease (token match); report whether a row was deleted.
create or replace function public.ebay_publish_lease_release(p_account_id uuid, p_sku text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare v_deleted integer;
begin
  delete from private.ebay_publish_leases where ebay_account_id = p_account_id and sku = p_sku and lease_token = p_token;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('released', v_deleted = 1);
end;
$$;
revoke all on function public.ebay_publish_lease_release(uuid, text, text) from public, anon, authenticated;
grant execute on function public.ebay_publish_lease_release(uuid, text, text) to service_role;
