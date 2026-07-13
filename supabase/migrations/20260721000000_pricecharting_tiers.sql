-- Persist the complete PriceCharting tier table per confirmed product, so a
-- saved slab's detail page shows the same pricing comparison that was available
-- during intake. Purely ADDITIVE: nullable columns + one new function. Existing
-- rows keep NULL tiers and continue to work with the sparse display fallback.

-- Structured tier table + raw audit response + retrieval timestamp (stale guard).
alter table public.slabs
  add column if not exists pricecharting_tiers     jsonb,
  add column if not exists pricecharting_raw        jsonb,
  add column if not exists pricecharting_priced_at  timestamptz;

comment on column public.slabs.pricecharting_tiers is
  'Structured PriceCharting tier table: { source, retrieved_at, tiers:[{tier,label,grader,grade,designation,value_cents,available,exact_match,source}] }. Unavailable tiers store value_cents = null, never 0.';
comment on column public.slabs.pricecharting_raw is
  'Raw token-free PriceCharting pricing response, preserved for audit only.';
comment on column public.slabs.pricecharting_priced_at is
  'Retrieval timestamp of the stored pricing; used to reject stale overwrites.';

-- Apply (or refresh) a slab's PriceCharting pricing with a stale-write guard.
-- Admin-gated (mirrors create_slab). A response older than the one already
-- stored is silently rejected so a late/stale fetch can never clobber newer
-- confirmed pricing. Returns true when the write was applied.
create or replace function public.apply_slab_pricing(
  p_slab_id   uuid,
  p_tiers     jsonb,
  p_raw       jsonb,
  p_priced_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_applied boolean := false;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  if p_priced_at is null then
    raise exception 'PRICED_AT_REQUIRED' using errcode = '22023';
  end if;

  update public.slabs
     set pricecharting_tiers    = p_tiers,
         pricecharting_raw       = p_raw,
         pricecharting_priced_at = p_priced_at
   where id = p_slab_id
     -- Stale guard: only overwrite when the incoming response is at least as new.
     and (pricecharting_priced_at is null or pricecharting_priced_at <= p_priced_at);

  get diagnostics v_applied = row_count;
  return v_applied > 0;
end;
$$;

grant execute on function public.apply_slab_pricing(uuid, jsonb, jsonb, timestamptz) to authenticated;
