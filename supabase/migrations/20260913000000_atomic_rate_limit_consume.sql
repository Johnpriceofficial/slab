-- =====================================================================
-- Atomic sliding-window rate limiting (canonicalized from frontend
-- backend-patch rate-limit-atomic + docs/backend-patches/rate_limit_hits.sql).
-- DISTINCT from public.api_rate_limits/reserve_api_request_slot (a pacing
-- reservation limiter for PriceCharting). This is a count-and-deny window
-- limiter for public endpoints (contact form/webhooks). LIVE call site:
-- slab-scribe-pro src/integrations/security/rate-limit.server.ts (service-role,
-- fail-closed). Service-role only; no anon/authenticated grants.
-- =====================================================================

-- Distributed rate limiting store for public endpoints (contact form, webhooks).
-- Hand this to the backend repository (Johnpriceofficial/slab) and apply it
-- there. Until it exists, protected server handlers must fail closed rather
-- than continue on a per-instance fallback.

CREATE TABLE IF NOT EXISTS public.rate_limit_hits (
  id bigserial PRIMARY KEY,
  bucket text NOT NULL,
  key_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_limit_hits_lookup_idx
  ON public.rate_limit_hits (bucket, key_hash, created_at DESC);

-- Server-only: no anon/authenticated grants. Reached with the service role
-- from server code that has already validated the request shape.
GRANT ALL ON public.rate_limit_hits TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.rate_limit_hits_id_seq TO service_role;

ALTER TABLE public.rate_limit_hits ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (which bypasses RLS) may read or write.

CREATE OR REPLACE FUNCTION public.prune_rate_limit_hits()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.rate_limit_hits WHERE created_at < now() - interval '1 day';
$$;

-- ---- atomic consume function -------------------------------------------
-- ==========================================================================
-- Atomic rate-limit consume function
-- Replaces the read-then-write pattern in rate-limit.server.ts with a
-- single SQL statement so concurrent requests at the window boundary cannot
-- both succeed by observing the same count before either has inserted.
--
-- Apply AFTER the rate_limit_hits table exists
-- (docs/backend-patches/rate_limit_hits.sql).
-- ==========================================================================

create or replace function public.try_rate_limit_consume(
  p_bucket       text,
  p_key_hash     text,
  p_max          integer,
  p_window_start timestamptz,
  p_hit_at       timestamptz
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bucket   text := btrim(coalesce(p_bucket, ''));
  v_key_hash text := btrim(coalesce(p_key_hash, ''));
  v_used     integer;
begin
  if v_bucket = '' then
    raise exception 'p_bucket must not be empty' using errcode = '22023';
  end if;
  if v_key_hash = '' then
    raise exception 'p_key_hash must not be empty' using errcode = '22023';
  end if;
  if p_max is null or p_max <= 0 then
    raise exception 'p_max must be greater than zero' using errcode = '22023';
  end if;
  if p_window_start is null or p_hit_at is null then
    raise exception 'timestamps must not be null' using errcode = '22023';
  end if;
  if p_window_start > p_hit_at then
    raise exception 'p_window_start must be less than or equal to p_hit_at' using errcode = '22023';
  end if;
  if p_window_start < p_hit_at - interval '1 day' then
    raise exception 'window must not exceed one day' using errcode = '22023';
  end if;
  if p_hit_at < timestamptz '2000-01-01 00:00:00+00'
     or p_hit_at > now() + interval '5 minutes' then
    raise exception 'p_hit_at is outside the accepted bounds' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_bucket || ':' || v_key_hash, 0));

  select count(*)
    into v_used
    from public.rate_limit_hits
   where bucket = v_bucket
     and key_hash = v_key_hash
     and created_at >= p_window_start;

  if v_used >= p_max then
    return false;
  end if;

  insert into public.rate_limit_hits (bucket, key_hash, created_at)
  values (v_bucket, v_key_hash, p_hit_at);

  return true;
end;
$$;

-- Only the service role (which bypasses RLS) may call this.
revoke all on function public.try_rate_limit_consume(text, text, integer, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.try_rate_limit_consume(text, text, integer, timestamptz, timestamptz)
  to service_role;
