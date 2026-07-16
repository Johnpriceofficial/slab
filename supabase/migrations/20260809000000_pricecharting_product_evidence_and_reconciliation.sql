-- Confirmed-product evidence persistence + valuation-status INTEGRITY.
--
-- pricecharting_raw is the full value response, so it carries the CURRENT
-- evidence: tier_availability, designation_exact, guide_value_cents, and
-- public_page.identity_status. Every integrity decision below is made from that
-- evidence, never from the valuation_provenance STRING alone.
--
--   1. Persist reference artwork + normalized tier snapshot + evidence timestamps
--      on public.pricecharting_products. last_verified_at updates ONLY when the
--      page identity actually VERIFIED; provider_evidence_at is the (always-known)
--      retrieval time.
--   2. exact_api_tier / snapshot EXACT require the exact tier to be present in the
--      CURRENT evidence (available + designation_exact + a non-null guide value).
--      Exact provenance without that evidence is 'needs_review', never exact.
--   3. When the current evidence does NOT support a trusted provider value
--      (needs_review / unavailable), the stale provider scalars are CLEARED so no
--      stale value can display as a current guide. Prior values remain in
--      valuation_snapshots for audit.
--   4. Reconcile existing rows the same way (clears the displayed stale value).

-- ── 1. Evidence columns on the catalog table ───────────────────────────────
alter table public.pricecharting_products
  add column if not exists reference_image_url    text,
  add column if not exists reference_image_source text,
  add column if not exists tier_snapshot          jsonb,
  add column if not exists last_verified_at       timestamptz,  -- identity actually verified
  add column if not exists provider_evidence_at   timestamptz;  -- evidence retrieved

-- ── 2/3. Capture trigger: evidence-based EXACT + stale-value clearing ───────
create or replace function public.capture_slab_valuation_snapshot()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_relation text;        -- snapshot tier_relationship (EXACT/COMPATIBLE/MANUAL/UNAVAILABLE)
  v_status text;          -- slabs.valuation_status
  v_confidence text;
  v_exact boolean;        -- the CURRENT evidence proves the exact tier
  v_page_verified boolean;
  v_clear boolean;        -- the provider scalars are untrustworthy → clear them
begin
  if new.pricecharting_priced_at is null or new.pricecharting_priced_at is not distinct from old.pricecharting_priced_at then
    return new;
  end if;

  -- EXACT is proven ONLY by the current evidence, not the provenance string.
  v_exact := (
    new.valuation_provenance = 'pricecharting_exact_tier'
    and new.pricecharting_value_cents is not null
    and new.pricecharting_raw->>'tier_availability' = 'available'
    and coalesce((new.pricecharting_raw->>'designation_exact')::boolean, false) = true
    and nullif(new.pricecharting_raw->>'guide_value_cents', '') is not null
  );
  -- Identity is "verified" only when the confirmed page identity VERIFIED.
  v_page_verified := coalesce(new.pricecharting_raw->'public_page'->>'identity_status', '') = 'VERIFIED';

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
      case when v_page_verified then new.pricecharting_priced_at else null end,
      new.pricecharting_priced_at
    ) on conflict (product_id) do update set
      product_name = excluded.product_name, console_name = excluded.console_name,
      raw_response = excluded.raw_response, last_refreshed_at = excluded.last_refreshed_at,
      -- Never blank out good evidence with a null from a lighter read.
      reference_image_url    = coalesce(excluded.reference_image_url, pricecharting_products.reference_image_url),
      reference_image_source = coalesce(excluded.reference_image_source, pricecharting_products.reference_image_source),
      tier_snapshot          = coalesce(excluded.tier_snapshot, pricecharting_products.tier_snapshot),
      -- last_verified_at advances ONLY on an actually-verified read; else keep prior.
      last_verified_at       = coalesce(excluded.last_verified_at, pricecharting_products.last_verified_at),
      provider_evidence_at   = excluded.provider_evidence_at;
  end if;

  -- Snapshot relationship: EXACT only when the evidence proves it. Exact
  -- provenance whose evidence fails is recorded as UNAVAILABLE (the exact tier was
  -- not actually available) — never a false EXACT snapshot.
  v_relation := case
    when v_exact then 'EXACT'
    when new.valuation_provenance = 'pricecharting_compatible_tier' then 'COMPATIBLE'
    when new.valuation_provenance in ('manual_guide', 'manual_value') then 'MANUAL'
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

  -- valuation_status from the same evidence. Exact provenance whose evidence fails
  -- → needs_review (never exact_api_tier).
  v_status := case
    when v_exact then 'exact_api_tier'
    when new.valuation_provenance = 'pricecharting_exact_tier' then 'needs_review'
    when new.valuation_provenance = 'pricecharting_compatible_tier' then 'compatible_api_tier'
    when new.valuation_provenance in ('manual_guide', 'manual_value') then 'manual'
    else 'unavailable' end;

  -- When there is no trusted provider value, CLEAR the provider scalars so nothing
  -- stale can display as the current guide. (Manual + compatible + exact keep theirs.)
  v_clear := v_status in ('needs_review', 'unavailable');
  update public.slabs set
    valuation_status        = v_status,
    pricecharting_value_cents = case when v_clear then null else pricecharting_value_cents end,
    final_value_cents         = case when v_clear then null else final_value_cents end,
    quick_sale_value_cents    = case when v_clear then null else quick_sale_value_cents end,
    replacement_value_cents   = case when v_clear then null else replacement_value_cents end
  where id = new.id;
  return new;
end;
$$;

drop trigger if exists slabs_capture_valuation_snapshot on public.slabs;
create trigger slabs_capture_valuation_snapshot
  after update of pricecharting_priced_at on public.slabs
  for each row execute function public.capture_slab_valuation_snapshot();

-- ── 4. Reconcile existing rows ─────────────────────────────────────────────
-- Demote any slab still marked exact_api_tier that the CURRENT raw evidence does
-- NOT support, and clear its stale provider scalars so the UI cannot show a stale
-- value. The authority is slabs.pricecharting_raw — the SAME evidence the new
-- trigger uses — NEVER the historical snapshot's tier_relationship (which was
-- written by the old provenance-based trigger and can read EXACT even when the
-- current evidence says the tier is unavailable). Historical snapshots are left
-- untouched for audit. Exposed as an idempotent function so it is independently
-- testable and re-runnable.
create or replace function public.reconcile_stale_exact_api_tier()
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.slabs s
  set valuation_status        = 'needs_review',
      pricecharting_value_cents = null,
      final_value_cents         = null,
      quick_sale_value_cents    = null,
      replacement_value_cents   = null
  where s.valuation_status = 'exact_api_tier'
    and not (
      s.valuation_provenance = 'pricecharting_exact_tier'
      and s.pricecharting_value_cents is not null
      and s.pricecharting_raw->>'tier_availability' = 'available'
      and coalesce((s.pricecharting_raw->>'designation_exact')::boolean, false) = true
      and nullif(s.pricecharting_raw->>'guide_value_cents', '') is not null
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- service_role only (an operator/maintenance action); never anon/authenticated.
revoke all on function public.reconcile_stale_exact_api_tier() from public;
grant execute on function public.reconcile_stale_exact_api_tier() to service_role;

-- Run the reconciliation now, as part of the migration.
select public.reconcile_stale_exact_api_tier();
