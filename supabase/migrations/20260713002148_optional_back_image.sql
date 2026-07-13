-- ============================================================================
-- SlabVault — make the BACK slab photo optional.
--
-- BUG: `valid_image_ext(null)` raised INVALID_IMAGE_EXTENSION for a null
-- extension, which meant create_slab hard-required a back image even when a
-- slab's front label carries every field needed for identification and
-- valuation. The front image stays required (identity/valuation are built
-- from it); the back becomes optional — a null back_image_path is a normal,
-- supported state, not an error.
-- ============================================================================

-- valid_image_ext: null/blank input is now a valid "not provided" signal and
-- returns null instead of raising. A NON-null, non-blank extension is still
-- validated against the same allow-list as before (unchanged behavior for
-- anything actually provided).
create or replace function public.valid_image_ext(p_ext text)
returns text
language plpgsql
immutable
as $$
declare
  e text;
begin
  if p_ext is null then
    return null;
  end if;
  e := lower(p_ext);
  if left(e, 1) = '.' then
    e := substr(e, 2); -- tolerate a single leading dot
  end if;
  if e = '' then
    return null; -- treat blank the same as "not provided"
  end if;
  -- The anchored allow-list rejects path separators ('/' '\'), and any
  -- traversal or dotted sequence, since none match a bare extension token.
  if e !~ '^(jpg|jpeg|png|webp|heic|heif)$' then
    raise exception 'INVALID_IMAGE_EXTENSION'
      using errcode = '22023', detail = coalesce(p_ext, '');
  end if;
  return e;
end;
$$;

-- create_slab: front image stays mandatory (explicit check + non-null path);
-- back image is optional (null p_back_ext -> null back_image_path, no back
-- path built). Everything else is carried forward unchanged from the prior
-- migration (validated extensions, grader-scoped normalized dup check,
-- sequence numbering, grade_label).
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

  if p_front_ext is null or trim(p_front_ext) = '' then
    raise exception 'FRONT_IMAGE_REQUIRED' using errcode = '22023';
  end if;

  v_front_ext := public.valid_image_ext(p_front_ext);
  v_back_ext  := public.valid_image_ext(p_back_ext); -- may be null: back is optional

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

  v_num := nextval('public.slab_inventory_seq');

  v_front_path := 'slabs/' || v_num || '/front.' || v_front_ext;
  v_back_path  := case when v_back_ext is not null then 'slabs/' || v_num || '/back.' || v_back_ext else null end;

  insert into public.slabs (
    inventory_number, card_name,
    final_value_cents, quick_sale_value_cents, replacement_value_cents,
    grader, grade, grade_label, certification_number, set_name, card_number, year,
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
    nullif(p->>'grade_label', ''),
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
