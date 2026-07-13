-- Complete the draft/verified contract and canonical valuation provenance.
-- This migration was not applied remotely when authored, so it is the safe
-- forward point for reconciling the earlier unconditional identity constraints.

-- Drafts may omit identity. Verified rows may not. The front photograph and a
-- recognized verification status are required for every persisted slab.
alter table public.slabs alter column card_name drop not null;
alter table public.slabs alter column grader drop not null;
alter table public.slabs alter column grade drop not null;
alter table public.slabs alter column certification_number drop not null;
alter table public.slabs alter column verification_status set not null;

alter table public.slabs drop constraint if exists slabs_card_name_nonblank;
alter table public.slabs drop constraint if exists slabs_grader_nonblank;
alter table public.slabs drop constraint if exists slabs_grade_nonblank;
alter table public.slabs drop constraint if exists slabs_cert_nonblank;
alter table public.slabs drop constraint if exists slabs_verification_nonblank;

alter table public.slabs
  add column if not exists valuation_provenance text;

-- Backfill provenance conservatively. A persisted exact tier is trusted only
-- when its own tier record says it was available and exact. Otherwise connected
-- values are compatible/estimated and operator values remain explicitly manual.
update public.slabs
set valuation_provenance = case
  when pricecharting_value_cents is null and final_value_cents is null then 'tier_unavailable'
  when pricecharting_product_id is not null
    and pricecharting_value_cents is not null
    and coalesce((pricecharting_raw->>'is_estimate')::boolean, false)
    then 'pricecharting_estimate'
  when pricecharting_product_id is not null
    and pricecharting_value_cents is not null
    and jsonb_path_exists(
      coalesce(pricecharting_tiers, '{}'::jsonb),
      '$.tiers[*] ? (@.exact_match == true && @.available == true)'
    )
    then 'pricecharting_exact_tier'
  when pricecharting_product_id is not null and pricecharting_value_cents is not null
    then 'pricecharting_compatible_tier'
  when pricecharting_value_cents is not null then 'manual_guide'
  when final_value_cents is not null then 'manual_value'
  else 'tier_unavailable'
end
where valuation_provenance is null;

-- Consolidate legacy confidence without overstating it. Verified is reserved
-- for a confirmed exact tier plus a positive visual confirmation.
update public.slabs
set valuation_confidence = case
  when valuation_provenance in ('manual_guide', 'manual_value') then 'manual'
  when valuation_provenance = 'tier_unavailable' then null
  when valuation_provenance = 'pricecharting_exact_tier'
    and visual_confirmation_status = 'user_confirmed' then 'verified'
  when valuation_provenance = 'pricecharting_exact_tier' then 'high'
  when valuation_provenance in ('pricecharting_compatible_tier', 'pricecharting_estimate') then 'moderate'
  when valuation_confidence = 'exact' then 'high'
  when valuation_confidence = 'probable' then 'moderate'
  when valuation_confidence in ('high', 'moderate', 'low') then valuation_confidence
  else 'low'
end;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'slabs_card_name_verified') then
    alter table public.slabs add constraint slabs_card_name_verified check (
      verification_status <> 'verified' or (card_name is not null and btrim(card_name) <> '')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_grader_verified') then
    alter table public.slabs add constraint slabs_grader_verified check (
      verification_status <> 'verified' or (grader is not null and btrim(grader) <> '')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_grade_verified') then
    alter table public.slabs add constraint slabs_grade_verified check (
      verification_status <> 'verified' or (grade is not null and btrim(grade) <> '')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_cert_verified') then
    alter table public.slabs add constraint slabs_cert_verified check (
      verification_status <> 'verified' or
      (certification_number is not null and btrim(certification_number) <> '')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_verification_status_chk') then
    alter table public.slabs add constraint slabs_verification_status_chk check (
      verification_status in ('verified', 'unverified', 'needs_clearer_images', 'label_error')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_front_image_required') then
    alter table public.slabs add constraint slabs_front_image_required check (
      front_image_path is not null and btrim(front_image_path) <> ''
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_valuation_provenance_chk') then
    alter table public.slabs add constraint slabs_valuation_provenance_chk check (
      valuation_provenance in (
        'pricecharting_exact_tier', 'pricecharting_compatible_tier',
        'pricecharting_estimate', 'manual_guide', 'manual_value', 'tier_unavailable'
      )
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_valuation_confidence_chk') then
    alter table public.slabs add constraint slabs_valuation_confidence_chk check (
      valuation_confidence is null or valuation_confidence in ('verified', 'high', 'moderate', 'low', 'manual')
    );
  end if;
end $$;

alter table public.slabs alter column valuation_provenance set not null;

-- A later visual decision must recompute the source confidence instead of
-- leaving a stale Verified label behind after rejection/invalidation.
create or replace function public.sync_visual_valuation_confidence()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.valuation_provenance = 'pricecharting_exact_tier' then
    new.valuation_confidence := case
      when new.visual_confirmation_status = 'user_confirmed' then 'verified'
      else 'high'
    end;
  elsif new.valuation_provenance in ('pricecharting_compatible_tier', 'pricecharting_estimate') then
    new.valuation_confidence := 'moderate';
  elsif new.valuation_provenance in ('manual_guide', 'manual_value') then
    new.valuation_confidence := 'manual';
  elsif new.valuation_provenance = 'tier_unavailable' then
    new.valuation_confidence := null;
  end if;
  return new;
end;
$$;

drop trigger if exists slabs_sync_visual_valuation_confidence on public.slabs;
create trigger slabs_sync_visual_valuation_confidence
  before update of visual_confirmation_status on public.slabs
  for each row
  when (old.visual_confirmation_status is distinct from new.visual_confirmation_status)
  execute function public.sync_visual_valuation_confidence();

-- Cumulative create function: sequence numbering, optional back image,
-- grader-scoped normalized duplicate protection, draft-aware identity, and
-- canonical valuation provenance.
create or replace function public.create_slab(p jsonb, p_front_ext text, p_back_ext text)
returns public.slabs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grader text;
  v_cert text;
  v_grader_n text;
  v_cert_n text;
  v_existing integer;
  v_num integer;
  v_front_ext text;
  v_back_ext text;
  v_front_path text;
  v_back_path text;
  v_row public.slabs;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_front_ext is null or btrim(p_front_ext) = '' then
    raise exception 'FRONT_IMAGE_REQUIRED' using errcode = '22023';
  end if;

  v_front_ext := public.valid_image_ext(p_front_ext);
  v_back_ext := public.valid_image_ext(p_back_ext);
  v_grader := nullif(btrim(p->>'grader'), '');
  v_cert := nullif(btrim(p->>'certification_number'), '');
  v_grader_n := public.normalize_grader(v_grader);
  v_cert_n := public.normalize_cert(v_cert);

  perform pg_advisory_xact_lock(918273645);
  if v_grader_n is not null and v_cert_n is not null then
    select inventory_number into v_existing
      from public.slabs
     where grader_normalized = v_grader_n
       and certification_number_normalized = v_cert_n
     limit 1;
    if v_existing is not null then
      raise exception 'DUPLICATE_CERTIFICATION'
        using errcode = '23505', detail = v_existing::text;
    end if;
  end if;

  v_num := nextval('public.slab_inventory_seq');
  v_front_path := 'slabs/' || v_num || '/front.' || v_front_ext;
  v_back_path := case when v_back_ext is null then null
    else 'slabs/' || v_num || '/back.' || v_back_ext end;

  insert into public.slabs (
    inventory_number, card_name,
    final_value_cents, quick_sale_value_cents, replacement_value_cents,
    grader, grade, grade_label, certification_number, set_name, card_number, year,
    language, rarity, variation, label_description, label_accuracy,
    verification_status, valuation_confidence, valuation_provenance, duplicate_status,
    pricecharting_product_id, pricecharting_product_name, pricecharting_grade_field,
    pricecharting_value_cents, pricecharting_sales_volume, pricecharting_match_status,
    price_variance_percent, front_image_path, back_image_path, notes, date_valued
  ) values (
    v_num, nullif(btrim(p->>'card_name'), ''),
    (p->>'final_value_cents')::bigint,
    (p->>'quick_sale_value_cents')::bigint,
    (p->>'replacement_value_cents')::bigint,
    v_grader, nullif(btrim(p->>'grade'), ''), nullif(btrim(p->>'grade_label'), ''), v_cert,
    nullif(btrim(p->>'set_name'), ''), nullif(btrim(p->>'card_number'), ''),
    (p->>'year')::integer, nullif(btrim(p->>'language'), ''),
    nullif(btrim(p->>'rarity'), ''), nullif(btrim(p->>'variation'), ''),
    nullif(btrim(p->>'label_description'), ''), nullif(btrim(p->>'label_accuracy'), ''),
    coalesce(nullif(p->>'verification_status', ''), 'unverified'),
    nullif(p->>'valuation_confidence', ''),
    coalesce(nullif(p->>'valuation_provenance', ''), 'tier_unavailable'),
    coalesce(nullif(p->>'duplicate_status', ''), 'unique'),
    nullif(p->>'pricecharting_product_id', ''), nullif(p->>'pricecharting_product_name', ''),
    nullif(p->>'pricecharting_grade_field', ''), (p->>'pricecharting_value_cents')::bigint,
    (p->>'pricecharting_sales_volume')::integer, nullif(p->>'pricecharting_match_status', ''),
    (p->>'price_variance_percent')::numeric, v_front_path, v_back_path,
    nullif(p->>'notes', ''), coalesce((p->>'date_valued')::timestamptz, now())
  ) returning * into v_row;

  return v_row;
end;
$$;

-- Atomic tier/scalar refresh. Provenance and confidence travel under the same
-- stale guard as the tier table; manual guide/value provenance is preserved when
-- the source has no usable tier.
create or replace function public.apply_slab_pricing(
  p_slab_id uuid,
  p_tiers jsonb,
  p_raw jsonb,
  p_priced_at timestamptz,
  p_scalars jsonb default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_has_scalars boolean := p_scalars is not null;
  v_apply_value boolean := coalesce((p_scalars->>'apply_value')::boolean, false);
  v_apply_provenance boolean := coalesce((p_scalars->>'apply_provenance')::boolean, false);
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_priced_at is null then
    raise exception 'PRICED_AT_REQUIRED' using errcode = '22023';
  end if;

  update public.slabs set
    pricecharting_tiers = p_tiers,
    pricecharting_raw = p_raw,
    pricecharting_priced_at = p_priced_at,
    pricecharting_product_id = case when v_has_scalars then p_scalars->>'product_id' else pricecharting_product_id end,
    pricecharting_product_name = case when v_has_scalars then p_scalars->>'product_name' else pricecharting_product_name end,
    pricecharting_grade_field = case when v_has_scalars then p_scalars->>'grade_field' else pricecharting_grade_field end,
    pricecharting_sales_volume = case when v_has_scalars then (p_scalars->>'sales_volume')::integer else pricecharting_sales_volume end,
    pricecharting_match_status = case when v_has_scalars then p_scalars->>'match_status' else pricecharting_match_status end,
    pricecharting_value_cents = case when v_apply_value then (p_scalars->>'value_cents')::bigint else pricecharting_value_cents end,
    price_variance_percent = case when v_apply_value then (p_scalars->>'variance')::numeric else price_variance_percent end,
    valuation_provenance = case when v_apply_provenance then p_scalars->>'valuation_provenance' else valuation_provenance end,
    valuation_confidence = case when v_apply_provenance then nullif(p_scalars->>'valuation_confidence', '') else valuation_confidence end
  where id = p_slab_id
    and (pricecharting_priced_at is null or pricecharting_priced_at <= p_priced_at);

  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

-- SECURITY DEFINER functions are not callable by PUBLIC/anon. Authenticated
-- callers still pass the in-function admin check before any data can change.
revoke all on function public.create_slab(jsonb, text, text) from public;
revoke all on function public.create_slab(jsonb, text, text) from anon;
grant execute on function public.create_slab(jsonb, text, text) to authenticated;
revoke all on function public.apply_slab_pricing(uuid, jsonb, jsonb, timestamptz, jsonb) from public;
revoke all on function public.apply_slab_pricing(uuid, jsonb, jsonb, timestamptz, jsonb) from anon;
grant execute on function public.apply_slab_pricing(uuid, jsonb, jsonb, timestamptz, jsonb) to authenticated;

-- Final SECURITY DEFINER privilege audit. PostgreSQL grants EXECUTE to PUBLIC on
-- new functions unless revoked; each surviving function is narrowed to the role
-- that actually invokes it. Every authenticated write RPC also checks is_admin.
revoke all on function public.is_admin(uuid) from public;
revoke all on function public.is_admin(uuid) from anon;
grant execute on function public.is_admin(uuid) to authenticated, service_role;

revoke all on function public.next_slab_inventory_number() from public;
revoke all on function public.next_slab_inventory_number() from anon;
revoke all on function public.next_slab_inventory_number() from authenticated;

revoke all on function public.check_slab_certification(text, text) from public;
revoke all on function public.check_slab_certification(text, text) from anon;
grant execute on function public.check_slab_certification(text, text) to authenticated;

revoke all on function public.archive_slab(uuid) from public;
revoke all on function public.archive_slab(uuid) from anon;
grant execute on function public.archive_slab(uuid) to authenticated;
revoke all on function public.unarchive_slab(uuid) from public;
revoke all on function public.unarchive_slab(uuid) from anon;
grant execute on function public.unarchive_slab(uuid) to authenticated;
revoke all on function public.hard_delete_slab(uuid) from public;
revoke all on function public.hard_delete_slab(uuid) from anon;
grant execute on function public.hard_delete_slab(uuid) to authenticated;

-- These infrastructure functions are called only from trusted Edge Functions
-- using the service role. Client sessions must not manipulate rate/quota state or
-- impersonate an admin by supplying p_requested_by.
revoke all on function public.reserve_api_request_slot(text, integer) from public;
revoke all on function public.reserve_api_request_slot(text, integer) from anon;
revoke all on function public.reserve_api_request_slot(text, integer) from authenticated;
grant execute on function public.reserve_api_request_slot(text, integer) to service_role;
revoke all on function public.consume_daily_quota(text, integer) from public;
revoke all on function public.consume_daily_quota(text, integer) from anon;
revoke all on function public.consume_daily_quota(text, integer) from authenticated;
grant execute on function public.consume_daily_quota(text, integer) to service_role;
revoke all on function public.cgc_claim_import_run(uuid, uuid, text, jsonb, numeric) from public;
revoke all on function public.cgc_claim_import_run(uuid, uuid, text, jsonb, numeric) from anon;
revoke all on function public.cgc_claim_import_run(uuid, uuid, text, jsonb, numeric) from authenticated;
grant execute on function public.cgc_claim_import_run(uuid, uuid, text, jsonb, numeric) to service_role;

-- Platform event-trigger helper is owner/internal only; it must not be exposed as
-- a REST RPC. Trigger execution does not require client EXECUTE privileges.
revoke all on function public.rls_auto_enable() from public;
revoke all on function public.rls_auto_enable() from anon;
revoke all on function public.rls_auto_enable() from authenticated;

-- Immutable/trigger helpers are invoker functions, but pin their lookup path as
-- well so the database advisor cannot report mutable-search-path ambiguity.
alter function public.slab_set_updated_at() set search_path = pg_catalog;
alter function public.valid_image_ext(text) set search_path = pg_catalog;
alter function public.normalize_cert(text) set search_path = pg_catalog;
alter function public.normalize_grader(text) set search_path = pg_catalog;
