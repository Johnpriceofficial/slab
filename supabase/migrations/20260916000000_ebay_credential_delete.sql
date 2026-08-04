-- 20260916000000_ebay_credential_delete.sql
-- Transactional, service-role-only local disconnect for the canonical private
-- eBay OAuth credential. This migration does not call eBay, does not touch the
-- legacy public OAuth tables, and does not enable any marketplace mutation.

begin;

create or replace function public.ebay_credential_delete(p_account_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_deleted integer := 0;
  v_account_exists boolean := false;
begin
  if p_account_id is null then
    raise exception 'account_id_required' using errcode = '22023';
  end if;

  select exists(
    select 1 from public.ebay_accounts a where a.id = p_account_id
  ) into v_account_exists;

  -- Idempotent for a missing account: no private row can be removed and no
  -- synthetic audit row should reference a nonexistent foreign key.
  if not v_account_exists then
    return 0;
  end if;

  delete from private.ebay_oauth_credentials
   where ebay_account_id = p_account_id;
  get diagnostics v_deleted = row_count;

  update public.ebay_accounts
     set connection_status = 'disconnected',
         privilege_status = null,
         authorization_expires_at = null,
         updated_at = now()
   where id = p_account_id;

  -- The audit write is in the same transaction as the credential deletion. A
  -- persistence error rolls back the entire disconnect instead of returning a
  -- false success after deleting the credential.
  insert into public.ebay_api_runs (
    ebay_account_id,
    operation,
    status,
    http_status,
    request_id,
    latency_ms,
    error_code
  ) values (
    p_account_id,
    'disconnect',
    'success',
    null,
    null,
    0,
    null
  );

  return v_deleted;
end;
$$;

comment on function public.ebay_credential_delete(uuid) is
  'Service-role-only transactional deletion of the canonical private eBay OAuth credential, public disconnect state update, and safe audit record.';

revoke all on function public.ebay_credential_delete(uuid) from public, anon, authenticated;
grant execute on function public.ebay_credential_delete(uuid) to service_role;

commit;
