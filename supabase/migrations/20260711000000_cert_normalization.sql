-- ============================================================================
-- SlabVault — grader-aware, normalized certification uniqueness.
--
-- PROBLEM (pre-migration): certification_number carried a GLOBAL unique
-- constraint and duplicate checks compared the raw string with no grader and no
-- normalization. That both (a) produced false collisions across graders (a PSA
-- cert and a CGC cert that share digits) and (b) missed real duplicates that
-- differed only by whitespace or letter case.
--
-- FIX: certification numbers are unique WITHIN a grading company. We add
-- normalized (grader, cert) columns and enforce uniqueness on the pair. The
-- original operator-entered certification_number text is preserved verbatim for
-- display and Excel export — normalization only powers uniqueness. Leading zeros
-- are preserved ("000123" != "123").
--
-- Parity: normalize_cert / normalize_grader below MUST match src/lib/slabs/
-- normalize.ts exactly (trim, strip all internal whitespace, uppercase).
-- ============================================================================

-- ─── normalization functions (IMMUTABLE; reused by RPCs) ────────────────────
create or replace function public.normalize_cert(p text)
returns text
language sql
immutable
as $$
  -- Strip ALL whitespace, uppercase, preserve everything else (incl. leading 0s).
  select nullif(upper(regexp_replace(coalesce(p, ''), '\s+', '', 'g')), '');
$$;

create or replace function public.normalize_grader(p text)
returns text
language sql
immutable
as $$
  select nullif(upper(regexp_replace(coalesce(p, ''), '\s+', '', 'g')), '');
$$;

-- ─── normalized columns (generated, always consistent, cannot drift) ────────
-- Inlined immutable expressions (kept identical to the functions above) so the
-- generated columns carry no dependency on the user-defined functions.
alter table public.slabs
  add column if not exists certification_number_normalized text
    generated always as (nullif(upper(regexp_replace(coalesce(certification_number, ''), '\s+', '', 'g')), '')) stored;

alter table public.slabs
  add column if not exists grader_normalized text
    generated always as (nullif(upper(regexp_replace(coalesce(grader, ''), '\s+', '', 'g')), '')) stored;

-- ─── swap the global unique for a grader-scoped composite unique ────────────
-- Drop the old global unique constraint on the raw certification number.
alter table public.slabs drop constraint if exists slabs_certification_number_key;

-- Uniqueness now applies to (grader, cert) after normalization. Partial index:
-- rows missing either part don't participate (an incomplete record can't be a
-- "duplicate"). Enforced constraints on completeness come in the next migration.
create unique index if not exists slabs_grader_cert_normalized_uidx
  on public.slabs (grader_normalized, certification_number_normalized)
  where grader_normalized is not null and certification_number_normalized is not null;

create index if not exists slabs_cert_normalized_idx on public.slabs (certification_number_normalized);

-- ============================================================================
-- check_slab_certification: now grader-aware. Returns the existing slab (if any)
-- whose normalized (grader, cert) matches the supplied pair. Admin-only.
-- Backward-compatible-ish: callers must pass grader now.
-- ============================================================================
drop function if exists public.check_slab_certification(text);

create or replace function public.check_slab_certification(p_grader text, p_cert text)
returns table (id uuid, inventory_number integer)
language sql
security definer
set search_path = public
as $$
  select s.id, s.inventory_number
  from public.slabs s
  where public.is_admin(auth.uid())
    and public.normalize_grader(p_grader) is not null
    and public.normalize_cert(p_cert) is not null
    and s.grader_normalized = public.normalize_grader(p_grader)
    and s.certification_number_normalized = public.normalize_cert(p_cert)
  limit 1;
$$;

grant execute on function public.normalize_cert(text) to authenticated, anon;
grant execute on function public.normalize_grader(text) to authenticated, anon;
grant execute on function public.check_slab_certification(text, text) to authenticated;

-- ============================================================================
-- create_slab: duplicate check is now grader-scoped + normalized.
-- (Inventory numbering still uses MAX+1 here; a later migration swaps it for a
-- durable sequence. Image-extension validation is added in the next migration.)
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
  v_front_path text;
  v_back_path  text;
  v_row        public.slabs;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  v_grader   := nullif(p->>'grader', '');
  v_cert     := nullif(p->>'certification_number', '');
  v_grader_n := public.normalize_grader(v_grader);
  v_cert_n   := public.normalize_cert(v_cert);

  -- Serialize number assignment + duplicate check together.
  perform pg_advisory_xact_lock(918273645);

  -- Grader-scoped duplicate check on the NORMALIZED pair.
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

  v_front_path := 'slabs/' || v_num || '/front.' || coalesce(nullif(p_front_ext, ''), 'jpg');
  v_back_path  := 'slabs/' || v_num || '/back.'  || coalesce(nullif(p_back_ext, ''),  'jpg');

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
