-- ============================================================================
-- eBay account-discovery persistence, honest scope provenance, single-flight
-- OAuth state, and safe API-run observability. All private/service-only work is
-- done through SECURITY DEFINER RPCs (execute -> service_role only); the private
-- schema stays hidden from the Data API.
-- ============================================================================

-- 1. Scope provenance: distinguish what we REQUEST/refresh with from what eBay
--    actually REPORTED as granted (eBay may omit `scope` on the token response).
alter table private.ebay_oauth_credentials
  add column if not exists requested_scopes      text[] not null default '{}',
  add column if not exists token_reported_scopes text[],
  add column if not exists scope_source          text;

-- Distinct connection timestamp (NOT a synchronization time).
alter table public.ebay_accounts add column if not exists connected_at timestamptz;

-- 2. Covering indexes (advisor: unindexed FK / query pattern).
create index if not exists idx_ebay_api_runs_account_created
  on public.ebay_api_runs (ebay_account_id, created_at desc);
create index if not exists idx_ebay_notifications_account_received
  on public.ebay_notifications (ebay_account_id, received_at desc);

-- 3. Backfill the existing connected credential(s): the canonical v38 six-scope
--    set as requested/refresh scopes, provenance = requested_fallback. Metadata
--    only — the encrypted refresh token is never read or rewritten.
update private.ebay_oauth_credentials
   set requested_scopes = array[
     'https://api.ebay.com/oauth/api_scope',
     'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
     'https://api.ebay.com/oauth/api_scope/sell.account',
     'https://api.ebay.com/oauth/api_scope/sell.inventory',
     'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
     'https://api.ebay.com/oauth/api_scope/sell.finances'
   ],
   scope_source = coalesce(scope_source, 'requested_fallback')
 where requested_scopes = '{}';

-- 4. Scope RPCs -------------------------------------------------------------
create or replace function public.ebay_credential_scopes_set(
  p_account_id uuid, p_requested_scopes text[], p_token_reported_scopes text[], p_scope_source text
) returns void language sql security definer set search_path = public, private, pg_temp as $$
  update private.ebay_oauth_credentials
     set requested_scopes      = coalesce(p_requested_scopes, requested_scopes),
         token_reported_scopes = p_token_reported_scopes,
         scope_source          = p_scope_source,
         -- keep the legacy `scopes` column populated with the best-known set
         scopes                = coalesce(p_token_reported_scopes, p_requested_scopes, scopes)
   where ebay_account_id = p_account_id;
$$;

create or replace function public.ebay_credential_scopes_get(p_account_id uuid)
returns table (requested_scopes text[], token_reported_scopes text[], scope_source text)
language sql security definer stable set search_path = public, private, pg_temp as $$
  select c.requested_scopes, c.token_reported_scopes, c.scope_source
  from private.ebay_oauth_credentials c where c.ebay_account_id = p_account_id;
$$;

-- 5. Discovery persistence RPCs (upsert + prune stale ONLY after a successful
--    provider fetch; the caller passes rows only when the fetch succeeded).
create or replace function public.ebay_inventory_locations_replace(p_account_id uuid, p_locations jsonb)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer; v_keys text[];
begin
  select coalesce(array_agg(x->>'merchant_location_key'), '{}') into v_keys
    from jsonb_array_elements(coalesce(p_locations, '[]'::jsonb)) x;
  insert into public.ebay_inventory_locations (ebay_account_id, merchant_location_key, status, raw_enum_value, last_synced_at)
  select p_account_id, x->>'merchant_location_key', x->>'status', x->>'raw_enum_value', now()
    from jsonb_array_elements(coalesce(p_locations, '[]'::jsonb)) x
  on conflict (ebay_account_id, merchant_location_key) do update
    set status = excluded.status, raw_enum_value = excluded.raw_enum_value, last_synced_at = excluded.last_synced_at;
  delete from public.ebay_inventory_locations
   where ebay_account_id = p_account_id and merchant_location_key <> all(v_keys);
  select count(*) into v_count from public.ebay_inventory_locations where ebay_account_id = p_account_id;
  return v_count;
end; $$;

create or replace function public.ebay_business_policies_replace(p_account_id uuid, p_policies jsonb)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer; v_ids text[];
begin
  select coalesce(array_agg(x->>'policy_id'), '{}') into v_ids
    from jsonb_array_elements(coalesce(p_policies, '[]'::jsonb)) x;
  insert into public.ebay_business_policies (ebay_account_id, policy_id, policy_type, name, marketplace_id, last_synced_at)
  select p_account_id, x->>'policy_id', x->>'policy_type', x->>'name', x->>'marketplace_id', now()
    from jsonb_array_elements(coalesce(p_policies, '[]'::jsonb)) x
  on conflict (ebay_account_id, policy_id) do update
    set policy_type = excluded.policy_type, name = excluded.name, marketplace_id = excluded.marketplace_id, last_synced_at = excluded.last_synced_at;
  delete from public.ebay_business_policies
   where ebay_account_id = p_account_id and policy_id <> all(v_ids);
  select count(*) into v_count from public.ebay_business_policies where ebay_account_id = p_account_id;
  return v_count;
end; $$;

-- 6. Safe API-run audit + per-resource sync cursor.
create or replace function public.ebay_api_run_record(
  p_account_id uuid, p_operation text, p_status text, p_http_status integer, p_request_id text, p_latency_ms integer, p_error_code text
) returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.ebay_api_runs (ebay_account_id, operation, status, http_status, request_id, latency_ms, error_code)
  values (p_account_id, p_operation, p_status, p_http_status, p_request_id, p_latency_ms, p_error_code);
$$;

create or replace function public.ebay_sync_cursor_touch(p_account_id uuid, p_resource_type text, p_count integer)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.ebay_sync_cursors (ebay_account_id, resource_type, cursor_value, last_synced_at)
  values (p_account_id, p_resource_type, p_count::text, now())
  on conflict (ebay_account_id, resource_type) do update
    set cursor_value = excluded.cursor_value, last_synced_at = excluded.last_synced_at;
$$;

-- 7. Single-flight OAuth state: advisory lock per admin, expire prior unconsumed
--    states, create exactly one. Consumed history is preserved.
create or replace function public.ebay_oauth_state_create_single_flight(
  p_state_hash text, p_requested_by uuid, p_expires_at timestamptz, p_redirect_after text
) returns void language plpgsql security definer set search_path = public, private, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_requested_by::text, 0));
  update private.ebay_oauth_states set expires_at = now()
   where requested_by = p_requested_by and consumed_at is null and expires_at > now();
  insert into private.ebay_oauth_states (state_hash, requested_by, expires_at, redirect_after)
  values (p_state_hash, p_requested_by, p_expires_at, p_redirect_after);
end; $$;

-- 8. Lock down every RPC to service_role only.
revoke all on function public.ebay_credential_scopes_set(uuid, text[], text[], text) from public, anon, authenticated;
revoke all on function public.ebay_credential_scopes_get(uuid) from public, anon, authenticated;
revoke all on function public.ebay_inventory_locations_replace(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ebay_business_policies_replace(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ebay_api_run_record(uuid, text, text, integer, text, integer, text) from public, anon, authenticated;
revoke all on function public.ebay_sync_cursor_touch(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.ebay_oauth_state_create_single_flight(text, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.ebay_credential_scopes_set(uuid, text[], text[], text) to service_role;
grant execute on function public.ebay_credential_scopes_get(uuid) to service_role;
grant execute on function public.ebay_inventory_locations_replace(uuid, jsonb) to service_role;
grant execute on function public.ebay_business_policies_replace(uuid, jsonb) to service_role;
grant execute on function public.ebay_api_run_record(uuid, text, text, integer, text, integer, text) to service_role;
grant execute on function public.ebay_sync_cursor_touch(uuid, text, integer) to service_role;
grant execute on function public.ebay_oauth_state_create_single_flight(text, uuid, timestamptz, text) to service_role;
