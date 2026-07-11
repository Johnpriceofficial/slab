-- ============================================================================
-- SlabVault — permanent, never-reused inventory numbers via a DB sequence.
--
-- POLICY (explicit):
--   * Inventory numbers are PERMANENT and NEVER reused.
--   * Archived slabs keep their number.
--   * New numbers come from a monotonic sequence (nextval), NOT MAX(...)+1.
--   * Gaps caused by failed transactions (a rejected duplicate, a hard-deleted
--     test record, a failed image upload that rolls back the row) are ACCEPTABLE
--     and expected. Numbering is NOT claimed to be gapless.
--
-- Why a sequence: MAX(inventory_number)+1 reused a number if the highest row was
-- deleted, and required a lock for correctness. nextval() is atomic, monotonic,
-- and survives deletes — a deleted top number becomes a permanent gap instead of
-- being reissued.
-- ============================================================================

create sequence if not exists public.slab_inventory_seq as integer minvalue 1;

-- Continue AFTER the current maximum so existing rows keep their numbers and the
-- next allocation never collides. setval(..., N, false) makes the next nextval
-- return exactly N.
select setval(
  'public.slab_inventory_seq',
  coalesce((select max(inventory_number) from public.slabs), 0) + 1,
  false
);

-- The old MAX-based helper implied gapless numbering; remove it to avoid reuse.
drop function if exists public.next_slab_inventory_number();

-- ============================================================================
-- create_slab: final form. Numbering now uses nextval() (permanent, non-reused).
-- Carries forward: admin gate, validated image extensions, grader-scoped
-- normalized duplicate check. The advisory lock is retained ONLY so the
-- duplicate check can raise a friendly DUPLICATE_CERTIFICATION (with the
-- existing inventory number) rather than a bare unique-violation under a race;
-- it no longer governs numbering, which the sequence handles.
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

  v_front_ext := public.valid_image_ext(p_front_ext);
  v_back_ext  := public.valid_image_ext(p_back_ext);

  v_grader   := nullif(p->>'grader', '');
  v_cert     := nullif(p->>'certification_number', '');
  v_grader_n := public.normalize_grader(v_grader);
  v_cert_n   := public.normalize_cert(v_cert);

  -- Serialize the duplicate check so we can return the friendly error + number.
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

  -- Permanent, never-reused number. Allocated only AFTER the duplicate check so
  -- a rejected duplicate does not burn a number (minimizes but does not
  -- eliminate gaps; gaps remain acceptable).
  v_num := nextval('public.slab_inventory_seq');

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
