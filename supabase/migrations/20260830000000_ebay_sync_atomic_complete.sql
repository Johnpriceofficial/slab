-- ============================================================================
-- PR C.8.1 (findings #2 + #3 + sync-state contract): ATOMIC sync completion, a
-- run identity, and active-runner-only failure.
--
--  * ebay_sync_state_load now stamps a fresh run_id when it marks the row
--    `running`, so only the active runner may fail/complete it.
--  * ebay_sync_complete is ONE transaction that: verifies the lease token is still
--    held (fencing), verifies the row is `running` with the expected run_id,
--    inserts the SUCCESS api-run audit, advances the watermark, stores counts +
--    overlap_start_at, and marks `complete`. Either all of that commits or none of
--    it does — the watermark is never advanced before the success audit exists.
--  * ebay_sync_state_fail only transitions a row that is `running` with the
--    matching run_id (a stale runner cannot overwrite a newer run's state).
-- service_role only.
-- ============================================================================

-- The non-atomic commit RPC is superseded by ebay_sync_complete (below).
drop function if exists public.ebay_sync_state_commit(uuid, text, uuid, timestamptz, integer, integer, integer, bigint);

create or replace function public.ebay_sync_state_load(p_account_id uuid, p_resource_type text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row public.ebay_sync_state;
begin
  insert into public.ebay_sync_state (ebay_account_id, resource_type)
  values (p_account_id, p_resource_type)
  on conflict (ebay_account_id, resource_type) do nothing;
  update public.ebay_sync_state
     set status = 'running', run_id = gen_random_uuid(), last_attempt_started_at = now(), updated_at = now()
   where ebay_account_id = p_account_id and resource_type = p_resource_type
   returning * into v_row;
  return jsonb_build_object('ok', true, 'run_id', v_row.run_id, 'high_watermark_at', v_row.high_watermark_at, 'status', v_row.status);
end;
$$;
revoke all on function public.ebay_sync_state_load(uuid, text) from public, anon, authenticated;
grant execute on function public.ebay_sync_state_load(uuid, text) to service_role;

create or replace function public.ebay_sync_complete(
  p_account_id uuid, p_resource_type text, p_run_id uuid, p_lease_token text,
  p_high_watermark_at timestamptz, p_overlap_start_at timestamptz,
  p_pages integer, p_records_fetched integer, p_records_persisted integer, p_durable_total bigint, p_latency_ms integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_state public.ebay_sync_state;
  v_lease_ok boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text || '|sync|' || coalesce(p_resource_type, ''), 0));

  -- FENCE: the caller must still hold a non-expired lease for this account+resource.
  select exists (
    select 1 from private.ebay_sync_leases
     where ebay_account_id = p_account_id and resource_type = p_resource_type and lease_token = p_lease_token and expires_at > v_now
  ) into v_lease_ok;
  if not v_lease_ok then
    return jsonb_build_object('ok', false, 'error_code', 'lease_lost');
  end if;

  -- Only the ACTIVE runner (running + matching run_id) may complete the run.
  select * into v_state from public.ebay_sync_state
   where ebay_account_id = p_account_id and resource_type = p_resource_type for update;
  if not found or v_state.status <> 'running' or v_state.run_id is distinct from p_run_id then
    return jsonb_build_object('ok', false, 'error_code', 'stale_runner');
  end if;

  -- SUCCESS audit + watermark advance + status, ALL in this one transaction.
  insert into public.ebay_api_runs (ebay_account_id, operation, status, http_status, request_id, latency_ms, error_code)
  values (p_account_id, p_resource_type || '_sync', 'success', null, null, greatest(0, coalesce(p_latency_ms, 0)), null);

  update public.ebay_sync_state
     set status = 'complete', high_watermark_at = p_high_watermark_at, overlap_start_at = p_overlap_start_at,
         pages_fetched = greatest(0, coalesce(p_pages, 0)), records_fetched = greatest(0, coalesce(p_records_fetched, 0)),
         records_persisted = greatest(0, coalesce(p_records_persisted, 0)), durable_total = p_durable_total,
         last_error_code = null, last_success_started_at = last_attempt_started_at,
         last_success_completed_at = v_now, last_attempt_completed_at = v_now, updated_at = v_now
   where ebay_account_id = p_account_id and resource_type = p_resource_type;

  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.ebay_sync_complete(uuid, text, uuid, text, timestamptz, timestamptz, integer, integer, integer, bigint, integer) from public, anon, authenticated;
grant execute on function public.ebay_sync_complete(uuid, text, uuid, text, timestamptz, timestamptz, integer, integer, integer, bigint, integer) to service_role;

create or replace function public.ebay_sync_state_fail(p_account_id uuid, p_resource_type text, p_run_id uuid, p_error_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_rows integer;
begin
  -- Only the active runner (running + matching run_id) may fail the run.
  update public.ebay_sync_state
     set status = 'failed', last_error_code = left(coalesce(p_error_code, 'unknown'), 100),
         last_attempt_completed_at = now(), updated_at = now()
   where ebay_account_id = p_account_id and resource_type = p_resource_type and status = 'running' and run_id is not distinct from p_run_id;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('ok', v_rows = 1);
end;
$$;
revoke all on function public.ebay_sync_state_fail(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.ebay_sync_state_fail(uuid, text, uuid, text) to service_role;
