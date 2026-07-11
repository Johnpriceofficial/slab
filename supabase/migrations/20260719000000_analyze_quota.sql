-- ============================================================================
-- SlabVault — durable daily usage quota (cost ceiling for paid AI calls).
--
-- analyze-slab is admin-gated but otherwise uncapped, so a compromised session
-- or a runaway UI loop could run up Anthropic spend without limit. This adds a
-- global per-day counter enforced in the database (across all edge isolates),
-- mirroring the PriceCharting reservation pattern.
-- ============================================================================

create table if not exists public.api_daily_usage (
  bucket     text not null,
  usage_date date not null default current_date,
  count      integer not null default 0,
  primary key (bucket, usage_date)
);

alter table public.api_daily_usage enable row level security;
-- No policies: only the SECURITY DEFINER RPC / service role may touch this.

-- consume_daily_quota: atomically checks today's count for the bucket and, if
-- under p_limit, increments and returns true (allowed). At/over the limit it
-- returns false WITHOUT incrementing (denied). Serialized per bucket+day.
create or replace function public.consume_daily_quota(p_bucket text, p_limit integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_bucket is null or btrim(p_bucket) = '' then
    raise exception 'INVALID_BUCKET' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('daily_quota:' || p_bucket || ':' || current_date::text));

  insert into public.api_daily_usage (bucket, usage_date, count)
    values (p_bucket, current_date, 0)
    on conflict (bucket, usage_date) do nothing;

  select count into v_count
    from public.api_daily_usage
    where bucket = p_bucket and usage_date = current_date
    for update;

  if v_count >= greatest(coalesce(p_limit, 0), 0) then
    return false; -- quota exhausted; do not increment
  end if;

  update public.api_daily_usage
    set count = count + 1
    where bucket = p_bucket and usage_date = current_date;
  return true;
end;
$$;

grant execute on function public.consume_daily_quota(text, integer) to authenticated;
