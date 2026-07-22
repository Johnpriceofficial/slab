-- ============================================================================
-- PR C.8: durable, versioned per-account/per-resource synchronization state for
-- restartable order + finance pagination with watermarks + deterministic recovery.
--
-- The high watermark advances ONLY when a run completes in full (all pages
-- fetched, all records persisted, state committed). A failed run retains the
-- previous watermark so the next run re-fetches the overlap and converges. NEVER
-- stores access tokens, auth headers, buyer PII, raw provider URLs with secrets,
-- or raw provider error bodies — only sanitized counts, codes, and a watermark.
-- All access is through service_role-only SECURITY DEFINER RPCs.
-- ============================================================================

create table if not exists public.ebay_sync_state (
  id uuid primary key default gen_random_uuid(),
  ebay_account_id uuid not null references public.ebay_accounts(id) on delete cascade,
  resource_type text not null check (resource_type in ('orders', 'finances')),
  state_version integer not null default 1,
  status text not null default 'idle' check (status in ('idle', 'running', 'failed', 'complete')),
  run_id uuid,
  high_watermark_at timestamptz,
  overlap_start_at timestamptz,
  last_success_started_at timestamptz,
  last_success_completed_at timestamptz,
  last_attempt_started_at timestamptz,
  last_attempt_completed_at timestamptz,
  pages_fetched integer not null default 0,
  records_fetched integer not null default 0,
  records_persisted integer not null default 0,
  durable_total bigint,
  last_error_code text,
  updated_at timestamptz not null default now(),
  unique (ebay_account_id, resource_type)
);
alter table public.ebay_sync_state enable row level security;
create policy ebay_sync_state_admin_read on public.ebay_sync_state
  for select to authenticated using (public.is_admin(auth.uid()));
grant select on public.ebay_sync_state to authenticated;
grant all on public.ebay_sync_state to service_role;

-- Load (upserting an idle row on first use) → returns the durable watermark + status.
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
     set status = 'running', last_attempt_started_at = now(), updated_at = now()
   where ebay_account_id = p_account_id and resource_type = p_resource_type
   returning * into v_row;
  return jsonb_build_object('ok', true, 'high_watermark_at', v_row.high_watermark_at, 'status', v_row.status);
end;
$$;
revoke all on function public.ebay_sync_state_load(uuid, text) from public, anon, authenticated;
grant execute on function public.ebay_sync_state_load(uuid, text) to service_role;

-- Commit a COMPLETED run: advance the watermark + record counts atomically.
create or replace function public.ebay_sync_state_commit(
  p_account_id uuid, p_resource_type text, p_run_id uuid, p_high_watermark_at timestamptz,
  p_pages integer, p_records_fetched integer, p_records_persisted integer, p_durable_total bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_rows integer;
begin
  update public.ebay_sync_state
     set status = 'complete', run_id = p_run_id, high_watermark_at = p_high_watermark_at,
         pages_fetched = greatest(0, coalesce(p_pages, 0)), records_fetched = greatest(0, coalesce(p_records_fetched, 0)),
         records_persisted = greatest(0, coalesce(p_records_persisted, 0)), durable_total = p_durable_total,
         last_error_code = null, last_success_started_at = last_attempt_started_at,
         last_success_completed_at = now(), last_attempt_completed_at = now(), updated_at = now()
   where ebay_account_id = p_account_id and resource_type = p_resource_type;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('ok', v_rows = 1);
end;
$$;
revoke all on function public.ebay_sync_state_commit(uuid, text, uuid, timestamptz, integer, integer, integer, bigint) from public, anon, authenticated;
grant execute on function public.ebay_sync_state_commit(uuid, text, uuid, timestamptz, integer, integer, integer, bigint) to service_role;

-- Record a FAILED run: retain the previous watermark, note a safe error code.
create or replace function public.ebay_sync_state_fail(p_account_id uuid, p_resource_type text, p_run_id uuid, p_error_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_rows integer;
begin
  update public.ebay_sync_state
     set status = 'failed', run_id = p_run_id, last_error_code = left(coalesce(p_error_code, 'unknown'), 100),
         last_attempt_completed_at = now(), updated_at = now()
   where ebay_account_id = p_account_id and resource_type = p_resource_type;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('ok', v_rows = 1);
end;
$$;
revoke all on function public.ebay_sync_state_fail(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.ebay_sync_state_fail(uuid, text, uuid, text) to service_role;
