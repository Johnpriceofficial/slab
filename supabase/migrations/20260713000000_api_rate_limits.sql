-- ============================================================================
-- SlabVault — durable, database-backed API rate limiting for PriceCharting.
--
-- PROBLEM: the in-memory RateLimiter is recreated per Edge Function request (and
-- per isolate), so it cannot enforce PriceCharting's 1 request/second limit
-- across concurrent requests or cold isolates.
--
-- FIX: a single global reservation counter per bucket, advanced atomically under
-- an advisory lock. reserve_api_request_slot() returns a timestamp at least
-- `min_interval_ms` after the previously reserved slot; the caller waits until
-- that time before contacting PriceCharting. Concurrent callers (any isolate)
-- serialize on the advisory lock and receive slots spaced ≥ the interval apart.
-- The in-memory limiter is retained as a secondary within-isolate safeguard.
-- ============================================================================

create table if not exists public.api_rate_limits (
  bucket           text primary key,
  last_reserved_at timestamptz not null default to_timestamp(0),
  min_interval_ms  integer not null default 1000,
  updated_at       timestamptz not null default now()
);

alter table public.api_rate_limits enable row level security;
-- No RLS policies: only SECURITY DEFINER RPCs (and the service role, which
-- bypasses RLS) may touch this table. Direct client access is denied by default.

-- ─── reserve one slot ───────────────────────────────────────────────────────
-- Returns the reserved execution time. First reservation for a bucket returns
-- ~now(); each subsequent reservation is >= previous + min_interval_ms.
create or replace function public.reserve_api_request_slot(
  p_bucket text,
  p_min_interval_ms integer default 1000
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_interval interval;
  v_reserved timestamptz;
begin
  if p_bucket is null or btrim(p_bucket) = '' then
    raise exception 'INVALID_BUCKET' using errcode = '22023';
  end if;
  v_interval := make_interval(secs => greatest(coalesce(p_min_interval_ms, 1000), 0) / 1000.0);

  -- Serialize every reserver for this bucket across all sessions/isolates.
  perform pg_advisory_xact_lock(hashtext('api_rate_limit:' || p_bucket));

  insert into public.api_rate_limits (bucket, last_reserved_at, min_interval_ms)
    values (p_bucket, to_timestamp(0), coalesce(p_min_interval_ms, 1000))
    on conflict (bucket) do nothing;

  select last_reserved_at into v_reserved
    from public.api_rate_limits
    where bucket = p_bucket
    for update;

  -- Next slot is the later of "now" and "previous slot + interval".
  v_reserved := greatest(clock_timestamp(), v_reserved + v_interval);

  update public.api_rate_limits
    set last_reserved_at = v_reserved,
        min_interval_ms  = coalesce(p_min_interval_ms, 1000),
        updated_at       = now()
    where bucket = p_bucket;

  return v_reserved;
end;
$$;

-- Admin callers may reserve (the Edge Function uses the service role, which
-- bypasses RLS anyway; this grant also enables the integration test harness).
grant execute on function public.reserve_api_request_slot(text, integer) to authenticated;
