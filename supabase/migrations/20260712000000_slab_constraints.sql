-- ============================================================================
-- SlabVault — database-level identity enforcement.
--
-- App-layer validation (validateSlabInput) is not a guarantee: a direct RPC or
-- SQL client could still create an incomplete record. These constraints make
-- the database itself reject records missing a card name, grader, grade,
-- certification number, verification status, or a positive inventory number,
-- and reject nonsensical years / negative money / bad image extensions.
--
-- NOTE: this assumes a clean (empty or already-valid) slabs table, which is the
-- case pre-deployment. If legacy rows violated these rules the ALTERs would
-- fail loudly — which is the correct signal, not something to silence.
--
-- Storage MIME-type and file-size limits are already enforced by the
-- slab-images bucket (20260710000001) and are intentionally left untouched. The
-- only storage-related addition here is filename-extension + path validation
-- inside create_slab, which the bucket does not cover.
-- ============================================================================

-- ─── required, non-blank identity fields ────────────────────────────────────
alter table public.slabs alter column card_name            set not null;
alter table public.slabs alter column grader               set not null;
alter table public.slabs alter column grade                set not null;
alter table public.slabs alter column certification_number set not null;
alter table public.slabs alter column verification_status  set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'slabs_card_name_nonblank') then
    alter table public.slabs add constraint slabs_card_name_nonblank check (btrim(card_name) <> '');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_grader_nonblank') then
    alter table public.slabs add constraint slabs_grader_nonblank check (btrim(grader) <> '');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_grade_nonblank') then
    alter table public.slabs add constraint slabs_grade_nonblank check (btrim(grade) <> '');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_cert_nonblank') then
    alter table public.slabs add constraint slabs_cert_nonblank check (btrim(certification_number) <> '');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_verification_nonblank') then
    alter table public.slabs add constraint slabs_verification_nonblank check (btrim(verification_status) <> '');
  end if;

  -- inventory number must be a positive integer
  if not exists (select 1 from pg_constraint where conname = 'slabs_inventory_number_positive') then
    alter table public.slabs add constraint slabs_inventory_number_positive check (inventory_number > 0);
  end if;

  -- plausible year (or null)
  if not exists (select 1 from pg_constraint where conname = 'slabs_year_range') then
    alter table public.slabs add constraint slabs_year_range check (year is null or (year between 1900 and 2100));
  end if;

  -- non-negative monetary values (variance may legitimately be negative)
  if not exists (select 1 from pg_constraint where conname = 'slabs_final_value_nonneg') then
    alter table public.slabs add constraint slabs_final_value_nonneg check (final_value_cents is null or final_value_cents >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_quick_value_nonneg') then
    alter table public.slabs add constraint slabs_quick_value_nonneg check (quick_sale_value_cents is null or quick_sale_value_cents >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_replacement_value_nonneg') then
    alter table public.slabs add constraint slabs_replacement_value_nonneg check (replacement_value_cents is null or replacement_value_cents >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_pc_value_nonneg') then
    alter table public.slabs add constraint slabs_pc_value_nonneg check (pricecharting_value_cents is null or pricecharting_value_cents >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_sales_volume_nonneg') then
    alter table public.slabs add constraint slabs_sales_volume_nonneg check (pricecharting_sales_volume is null or pricecharting_sales_volume >= 0);
  end if;
end $$;

-- Comp money must be non-negative too.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'slab_comps_money_nonneg') then
    alter table public.slab_comps add constraint slab_comps_money_nonneg check (
      (sold_price_cents  is null or sold_price_cents  >= 0) and
      (shipping_cents    is null or shipping_cents    >= 0) and
      (total_price_cents is null or total_price_cents >= 0)
    );
  end if;
end $$;

-- ============================================================================
-- Image extension validation. The bucket enforces MIME + size; this closes the
-- remaining gap: create_slab must not build a storage path from an unsupported
-- extension, a path separator, or a traversal sequence. Only these are allowed:
--   jpg jpeg png webp heic heif
-- ============================================================================
create or replace function public.valid_image_ext(p_ext text)
returns text
language plpgsql
immutable
as $$
declare
  e text;
begin
  e := lower(coalesce(p_ext, ''));
  if left(e, 1) = '.' then
    e := substr(e, 2); -- tolerate a single leading dot
  end if;
  -- The anchored allow-list rejects '', path separators ('/' '\'), and any
  -- traversal or dotted sequence, since none match a bare extension token.
  if e !~ '^(jpg|jpeg|png|webp|heic|heif)$' then
    raise exception 'INVALID_IMAGE_EXTENSION'
      using errcode = '22023', detail = coalesce(p_ext, '');
  end if;
  return e;
end;
$$;

grant execute on function public.valid_image_ext(text) to authenticated;

-- ============================================================================
-- create_slab: adds validated image extensions (no silent 'jpg' fallback).
-- Carries forward the grader-scoped normalized duplicate check from the prior
-- migration. (Inventory numbering still MAX+1 here; a later migration swaps it
-- for a durable sequence.)
-- ============================================================================
create or replace function public.create_slab(p jsonb, p_front_ext text, p_back_ext text)
returns public.slabs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grader     text;
  v_cert       text;
  v_grader_n   text;
  v_cert_n     text;
  v_existing   integer;
  v_num        integer;
  v_front_ext  text;
  v_back_ext   text;
  v_front_path text;
  v_back_path  text;
  v_row        public.slabs;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  -- Validate extensions BEFORE taking the lock / assigning a number.
  v_front_ext := public.valid_image_ext(p_front_ext);
  v_back_ext  := public.valid_image_ext(p_back_ext);

  v_grader   := nullif(p->>'grader', '');
  v_cert     := nullif(p->>'certification_number', '');
  v_grader_n := public.normalize_grader(v_grader);
  v_cert_n   := public.normalize_cert(v_cert);

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

  select coalesce(max(inventory_number), 0) + 1 into v_num from public.slabs;

  v_front_path := 'slabs/' || v_num || '/front.' || v_front_ext;
  v_back_path  := 'slabs/' || v_num || '/back.'  || v_back_ext;

  insert into public.slabs (
    inventory_number, card_name,
    final_value_cents, quick_sale_value_cents, replacement_value_cents,
    grader, grade, certification_number, set_name, card_number, year,
    language, rarity, variation, label_description, label_accuracy,
    verification_status, valuation_confidence, duplicate_status,
    pricecharting_product_id, pricecharting_product_name, pricecharting_grade_field,
    pricecharting_value_cents, pricecharting_sales_volume, pricecharting_match_status,
    price_variance_percent, front_image_path, back_image_path, notes, date_valued
  ) values (
    v_num,
    p->>'card_name',
    (p->>'final_value_cents')::bigint,
    (p->>'quick_sale_value_cents')::bigint,
    (p->>'replacement_value_cents')::bigint,
    v_grader,
    p->>'grade',
    v_cert,
    p->>'set_name',
    p->>'card_number',
    (p->>'year')::integer,
    p->>'language',
    p->>'rarity',
    p->>'variation',
    p->>'label_description',
    p->>'label_accuracy',
    coalesce(p->>'verification_status', 'unverified'),
    p->>'valuation_confidence',
    coalesce(p->>'duplicate_status', 'unique'),
    p->>'pricecharting_product_id',
    p->>'pricecharting_product_name',
    p->>'pricecharting_grade_field',
    (p->>'pricecharting_value_cents')::bigint,
    (p->>'pricecharting_sales_volume')::integer,
    p->>'pricecharting_match_status',
    (p->>'price_variance_percent')::numeric,
    v_front_path,
    v_back_path,
    p->>'notes',
    coalesce((p->>'date_valued')::timestamptz, now())
  )
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.create_slab(jsonb, text, text) to authenticated;
