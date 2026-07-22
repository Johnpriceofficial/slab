-- ============================================================================
-- PR C.8.1 review (finding #2): FENCE begin-run with the lease token.
--
-- ebay_sync_state_load previously generated a fresh run_id without verifying the
-- caller still held the active, non-expired lease — so a paused runner whose lease
-- had expired could resume and overwrite a newer runner's run_id. This replaces it
-- with a token-fenced version: under the SAME account/resource advisory lock as the
-- lease, it verifies the exact lease token is present and unexpired BEFORE creating
-- the new run_id / marking `running`. On rejection NO state changes. service_role only.
-- ============================================================================

drop function if exists public.ebay_sync_state_load(uuid, text);

create or replace function public.ebay_sync_state_load(p_account_id uuid, p_resource_type text, p_lease_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_row public.ebay_sync_state;
  v_lease_ok boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text || '|sync|' || coalesce(p_resource_type, ''), 0));

  -- FENCE: the caller must still hold a non-expired lease for this account+resource.
  select exists (
    select 1 from private.ebay_sync_leases
     where ebay_account_id = p_account_id and resource_type = p_resource_type and lease_token = p_lease_token and expires_at > now()
  ) into v_lease_ok;
  if not v_lease_ok then
    return jsonb_build_object('ok', false, 'error_code', 'lease_lost');
  end if;

  insert into public.ebay_sync_state (ebay_account_id, resource_type)
  values (p_account_id, p_resource_type)
  on conflict (ebay_account_id, resource_type) do nothing;
  update public.ebay_sync_state
     set status = 'running', run_id = gen_random_uuid(), last_attempt_started_at = now(), updated_at = now()
   where ebay_account_id = p_account_id and resource_type = p_resource_type
   returning * into v_row;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'sync_begin_failed');
  end if;
  return jsonb_build_object('ok', true, 'run_id', v_row.run_id, 'high_watermark_at', v_row.high_watermark_at);
end;
$$;
revoke all on function public.ebay_sync_state_load(uuid, text, text) from public, anon, authenticated;
grant execute on function public.ebay_sync_state_load(uuid, text, text) to service_role;
