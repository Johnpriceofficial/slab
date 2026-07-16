-- Confirmed-product evidence persistence + valuation-status integrity.
--
-- Three concerns, all additive/non-destructive:
--   1. Persist the confirmed product's reference artwork, normalized tier
--      snapshot, and evidence timestamps on public.pricecharting_products, so the
--      canonical catalog row carries the page evidence (not just the raw blob).
--   2. GUARD valuation_status: a slab may be 'exact_api_tier' ONLY when the exact
--      tier actually resolved to a value. 'pricecharting_exact_tier' provenance
--      with a NULL value is NOT exact — it becomes 'needs_review'.
--   3. RECONCILE existing rows: demote any slab currently marked 'exact_api_tier'
--      whose value is null OR whose latest snapshot is not EXACT (a stale scalar
--      superseded by a later "tier unavailable" evidence read) to 'needs_review'.
--      No scalar is deleted — the value is preserved for audit, just no longer
--      trusted as an exact API tier.

-- ── 1. Evidence columns on the catalog table ───────────────────────────────
alter table public.pricecharting_products
  add column if not exists reference_image_url    text,
  add column if not exists reference_image_source text,
  -- The complete normalized tier→cents map for this product (from the confirmed
  -- API + page evidence), so the full grade table survives without a re-fetch.
  add column if not exists tier_snapshot          jsonb,
  -- When the product IDENTITY was last verified (API/page identity agreed).
  add column if not exists last_verified_at       timestamptz,
  -- When the underlying provider evidence (prices/artwork) was retrieved.
  add column if not exists provider_evidence_at   timestamptz;

-- ── 2. + best-effort persistence: re-create the capture trigger with the guard
-- and evidence population. Body is IDENTICAL to the prior version except: the
-- product upsert also persists artwork/tier-snapshot/timestamps (defensively read
-- from the raw response — NULL when absent), and the final status assignment gates
-- 'exact_api_tier' on a non-null value.
create or replace function public.capture_slab_valuation_snapshot()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_relation text;
  v_confidence text;
begin
  if new.pricecharting_priced_at is null or new.pricecharting_priced_at is not distinct from old.pricecharting_priced_at then
    return new;
  end if;
  if new.pricecharting_product_id is not null then
    insert into public.pricecharting_products (
      product_id, product_name, console_name, raw_response, last_refreshed_at,
      reference_image_url, reference_image_source, tier_snapshot,
      last_verified_at, provider_evidence_at
    )
    values (
      new.pricecharting_product_id, coalesce(new.pricecharting_product_name, 'Unknown PriceCharting product'),
      new.pricecharting_raw->>'console_or_category', coalesce(new.pricecharting_raw, '{}'::jsonb), new.pricecharting_priced_at,
      new.pricecharting_raw->'reference_artwork'->>'image_url',
      new.pricecharting_raw->'reference_artwork'->>'image_source',
      new.pricecharting_raw->'available_values_cents',
      new.pricecharting_priced_at,
      new.pricecharting_priced_at
    ) on conflict (product_id) do update set
      product_name = excluded.product_name, console_name = excluded.console_name,
      raw_response = excluded.raw_response, last_refreshed_at = excluded.last_refreshed_at,
      -- Only overwrite artwork/tier evidence when the new read actually carries it
      -- (never blank out good evidence with a null from a lighter read).
      reference_image_url    = coalesce(excluded.reference_image_url, pricecharting_products.reference_image_url),
      reference_image_source = coalesce(excluded.reference_image_source, pricecharting_products.reference_image_source),
      tier_snapshot          = coalesce(excluded.tier_snapshot, pricecharting_products.tier_snapshot),
      last_verified_at       = excluded.last_verified_at,
      provider_evidence_at   = excluded.provider_evidence_at;
  end if;
  v_relation := case new.valuation_provenance
    when 'pricecharting_exact_tier' then 'EXACT'
    when 'pricecharting_compatible_tier' then 'COMPATIBLE'
    when 'manual_guide' then 'MANUAL'
    when 'manual_value' then 'MANUAL'
    else 'UNAVAILABLE' end;
  v_confidence := case v_relation when 'EXACT' then 'HIGH' when 'COMPATIBLE' then 'MEDIUM' when 'MANUAL' then 'MANUAL' else 'UNAVAILABLE' end;
  insert into public.valuation_snapshots (
    slab_id, pricecharting_product_id, source_field, tier_relationship,
    guide_value_cents, quick_sale_value_cents, replacement_value_cents,
    currency, confidence, raw_response, valued_at
  ) values (
    new.id, new.pricecharting_product_id, new.pricecharting_grade_field, v_relation,
    new.pricecharting_value_cents,
    case when new.pricecharting_value_cents is null then null else round(new.pricecharting_value_cents * 0.80)::bigint end,
    case when new.pricecharting_value_cents is null then null else round(new.pricecharting_value_cents * 1.10)::bigint end,
    'USD', v_confidence, new.pricecharting_raw, new.pricecharting_priced_at
  );
  update public.slabs set valuation_status = case
    -- EXACT counts as exact_api_tier ONLY when a real value resolved. Exact
    -- provenance with no value is not exact — flag it for review, never claim exact.
    when v_relation = 'EXACT' and new.pricecharting_value_cents is not null then 'exact_api_tier'
    when v_relation = 'EXACT' then 'needs_review'
    when v_relation = 'COMPATIBLE' then 'compatible_api_tier'
    when v_relation = 'MANUAL' then 'manual'
    else 'unavailable' end
  where id = new.id;
  return new;
end;
$$;

drop trigger if exists slabs_capture_valuation_snapshot on public.slabs;
create trigger slabs_capture_valuation_snapshot
  after update of pricecharting_priced_at on public.slabs
  for each row execute function public.capture_slab_valuation_snapshot();

-- ── 3. Reconcile existing rows ─────────────────────────────────────────────
-- Demote any slab still marked exact_api_tier that is NOT actually backed by an
-- exact tier value: either it has no value, or its LATEST valuation snapshot is
-- not EXACT (a later read found the tier unavailable and the scalar went stale).
-- Non-destructive: the scalar value is retained; only the trust status changes.
update public.slabs s
set valuation_status = 'needs_review'
where s.valuation_status = 'exact_api_tier'
  and (
    s.pricecharting_value_cents is null
    or coalesce((
      select vs.tier_relationship
      from public.valuation_snapshots vs
      where vs.slab_id = s.id
      order by vs.valued_at desc
      limit 1
    ), 'UNAVAILABLE') <> 'EXACT'
  );
