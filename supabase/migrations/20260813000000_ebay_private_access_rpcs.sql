-- ============================================================================
-- eBay private-schema access via SECURITY DEFINER RPCs.
--
-- The eBay Edge Functions previously reached the private schema with
-- `admin.schema("private").from(...)`, which routes through PostgREST and
-- therefore requires `private` to be a Data-API "exposed schema". It is NOT —
-- by design: `private` holds encrypted refresh tokens, buyer PII, and financial
-- data and must never be reachable from the Data API. As a result EVERY private
-- write failed with PGRST106 "Invalid schema: private", which is why no eBay
-- OAuth state, credential, order, or transaction has ever persisted.
--
-- These wrappers live in the exposed `public` schema, run SECURITY DEFINER (as
-- the owner, which CAN reach `private`), and are EXECUTE-granted to
-- `service_role` ONLY (revoked from public/anon/authenticated). Only the
-- server-side Edge Functions (service role) can call them; the browser cannot.
-- `private` stays hidden from the Data API. Each function is parameterized (no
-- dynamic SQL) and pins an explicit search_path.
--
-- Scope: the OAuth-state + credential operations that unblock the connection and
-- account-discovery flow. The order/fulfillment/finance private writes get the
-- same treatment in their own migrations when those phases are built.
-- ============================================================================

-- 1. OAuth state --------------------------------------------------------------
create or replace function public.ebay_oauth_state_create(
  p_state_hash text,
  p_requested_by uuid,
  p_expires_at timestamptz,
  p_redirect_after text
) returns void
language sql
security definer
set search_path = public, private, pg_temp
as $$
  insert into private.ebay_oauth_states (state_hash, requested_by, expires_at, redirect_after)
  values (p_state_hash, p_requested_by, p_expires_at, p_redirect_after);
$$;

create or replace function public.ebay_oauth_state_get(p_state_hash text)
returns table (requested_by uuid, expires_at timestamptz, consumed_at timestamptz, redirect_after text)
language sql
security definer
stable
set search_path = public, private, pg_temp
as $$
  select s.requested_by, s.expires_at, s.consumed_at, s.redirect_after
  from private.ebay_oauth_states s
  where s.state_hash = p_state_hash;
$$;

create or replace function public.ebay_oauth_state_consume(p_state_hash text)
returns void
language sql
security definer
set search_path = public, private, pg_temp
as $$
  update private.ebay_oauth_states
     set consumed_at = now()
   where state_hash = p_state_hash and consumed_at is null;
$$;

-- 2. OAuth credentials --------------------------------------------------------
create or replace function public.ebay_oauth_credential_upsert(
  p_account_id uuid,
  p_refresh_token_encrypted text,
  p_refresh_token_expires_at timestamptz,
  p_scopes text[],
  p_rotated_at timestamptz
) returns void
language sql
security definer
set search_path = public, private, pg_temp
as $$
  insert into private.ebay_oauth_credentials
    (ebay_account_id, refresh_token_encrypted, refresh_token_expires_at, scopes, rotated_at)
  values
    (p_account_id, p_refresh_token_encrypted, p_refresh_token_expires_at, coalesce(p_scopes, '{}'), p_rotated_at)
  on conflict (ebay_account_id) do update
    set refresh_token_encrypted  = excluded.refresh_token_encrypted,
        refresh_token_expires_at = excluded.refresh_token_expires_at,
        scopes                   = excluded.scopes,
        rotated_at               = excluded.rotated_at;
$$;

create or replace function public.ebay_oauth_credential_get(p_account_id uuid)
returns table (refresh_token_encrypted text, scopes text[])
language sql
security definer
stable
set search_path = public, private, pg_temp
as $$
  select c.refresh_token_encrypted, c.scopes
  from private.ebay_oauth_credentials c
  where c.ebay_account_id = p_account_id;
$$;

-- Optimistic-concurrency rotation: overwrite ONLY while the stored ciphertext is
-- still the one the caller refreshed from, and only for this account. Returns the
-- number of rows changed (0 => a concurrent refresh already rotated it, so the
-- newer token is kept; 1 => rotated). A failed write (raised error) propagates.
create or replace function public.ebay_oauth_credential_rotate(
  p_account_id uuid,
  p_prior_encrypted text,
  p_new_encrypted text,
  p_refresh_token_expires_at timestamptz,
  p_scopes text[],
  p_rotated_at timestamptz
) returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_count integer;
begin
  update private.ebay_oauth_credentials
     set refresh_token_encrypted  = p_new_encrypted,
         refresh_token_expires_at = coalesce(p_refresh_token_expires_at, refresh_token_expires_at),
         scopes                   = case when p_scopes is not null and array_length(p_scopes, 1) is not null then p_scopes else scopes end,
         rotated_at               = p_rotated_at
   where ebay_account_id = p_account_id
     and refresh_token_encrypted = p_prior_encrypted;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 3. Lock down: server-side (service_role) only -------------------------------
revoke all on function public.ebay_oauth_state_create(text, uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function public.ebay_oauth_state_get(text) from public, anon, authenticated;
revoke all on function public.ebay_oauth_state_consume(text) from public, anon, authenticated;
revoke all on function public.ebay_oauth_credential_upsert(uuid, text, timestamptz, text[], timestamptz) from public, anon, authenticated;
revoke all on function public.ebay_oauth_credential_get(uuid) from public, anon, authenticated;
revoke all on function public.ebay_oauth_credential_rotate(uuid, text, text, timestamptz, text[], timestamptz) from public, anon, authenticated;

grant execute on function public.ebay_oauth_state_create(text, uuid, timestamptz, text) to service_role;
grant execute on function public.ebay_oauth_state_get(text) to service_role;
grant execute on function public.ebay_oauth_state_consume(text) to service_role;
grant execute on function public.ebay_oauth_credential_upsert(uuid, text, timestamptz, text[], timestamptz) to service_role;
grant execute on function public.ebay_oauth_credential_get(uuid) to service_role;
grant execute on function public.ebay_oauth_credential_rotate(uuid, text, text, timestamptz, text[], timestamptz) to service_role;
