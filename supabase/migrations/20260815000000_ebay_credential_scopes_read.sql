-- ============================================================================
-- PR A.1: make refreshes actually use the persisted per-account scope metadata,
-- and backfill connected_at for the already-connected account. Metadata only —
-- no refresh token / ciphertext is read or rewritten here.
-- ============================================================================

-- ebay_oauth_credential_get returned only (refresh_token_encrypted, scopes), so
-- userAccessToken's read of credential.requested_scopes was always undefined and
-- silently fell back to the canonical set. Return the full scope provenance so
-- the stored per-account requested scopes actually drive refresh. Changing the
-- RETURNS TABLE shape requires drop + recreate.
drop function if exists public.ebay_oauth_credential_get(uuid);
create or replace function public.ebay_oauth_credential_get(p_account_id uuid)
returns table (
  refresh_token_encrypted text,
  requested_scopes text[],
  token_reported_scopes text[],
  scope_source text,
  scopes text[]
)
language sql security definer stable set search_path = public, private, pg_temp as $$
  select c.refresh_token_encrypted, c.requested_scopes, c.token_reported_scopes, c.scope_source, c.scopes
  from private.ebay_oauth_credentials c
  where c.ebay_account_id = p_account_id;
$$;
revoke all on function public.ebay_oauth_credential_get(uuid) from public, anon, authenticated;
grant execute on function public.ebay_oauth_credential_get(uuid) to service_role;

-- Backfill connected_at from created_at for existing connected accounts (the
-- callback only sets it on future connections). Safe, metadata only.
update public.ebay_accounts
   set connected_at = coalesce(connected_at, created_at)
 where connection_status = 'connected' and connected_at is null;
