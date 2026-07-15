-- ============================================================================
-- GradedCardValue.com — permanent public inventory identifiers.
--
-- Every item gets a stable, human-facing code: slabs "S0001, S0002, …", raw
-- cards "R0001, …" (the R sequence is created here for a later raw/slab change;
-- this migration assigns codes to SLABS only). Codes are:
--   * permanent and NEVER reused — separate monotonic sequences, survive
--     archive/hard-delete as gaps, exactly like inventory_number,
--   * immutable after creation (enforced by a trigger; the code column is
--     generated and cannot be written directly),
--   * at least four digits, expanding indefinitely past 9999,
--   * searchable by full code ("S0001") or numeric portion ("0001", "1").
--
-- Additive and non-breaking:
--   * inventory_number is UNTOUCHED. Storage paths (slabs/{inventory_number}/…),
--     the slab_object_owner storage RLS, and eBay SKUs all continue to key on
--     it. The public code is a NEW identifier layered on top, never a rename.
--   * Assignment is server-side only (a SECURITY DEFINER RPC + DB sequences);
--     the client never supplies a code.
-- ============================================================================

-- ── 1. Public identifier columns ────────────────────────────────────────────
alter table public.slabs
  add column if not exists inventory_prefix text not null default 'S',
  add column if not exists inventory_sequence integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'slabs_inventory_prefix_chk') then
    alter table public.slabs add constraint slabs_inventory_prefix_chk check (inventory_prefix ~ '^[A-Z]$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_inventory_sequence_positive') then
    alter table public.slabs add constraint slabs_inventory_sequence_positive check (inventory_sequence is null or inventory_sequence >= 1);
  end if;
end $$;

-- The code is DERIVED, never stored independently: it cannot drift from its
-- prefix+sequence, and a generated column cannot be written, so it is immutable
-- by construction. lpad pads to 4 digits and leaves longer numbers intact.
alter table public.slabs
  add column if not exists inventory_code text
    generated always as (inventory_prefix || lpad(inventory_sequence::text, 4, '0')) stored;

-- ── 2. Separate, never-reused public sequences ──────────────────────────────
create sequence if not exists public.slab_public_seq as integer minvalue 1;
create sequence if not exists public.raw_public_seq as integer minvalue 1;

-- ── 3. Deterministic backfill (stable, order-independent of when it runs) ───
-- Existing slabs are numbered by their existing inventory_number, so the mapping
-- is fully determined by current data: the earliest slab becomes S0001, and a
-- re-run produces the identical assignment.
with ordered as (
  select id, row_number() over (order by inventory_number asc) as seq
  from public.slabs
)
update public.slabs s
   set inventory_prefix = 'S',
       inventory_sequence = o.seq
  from ordered o
 where o.id = s.id
   and s.inventory_sequence is null;

-- Advance the sequence past the backfilled maximum so the next allocation never
-- collides and never reuses a backfilled number.
select setval(
  'public.slab_public_seq',
  coalesce((select max(inventory_sequence) from public.slabs where inventory_prefix = 'S'), 0) + 1,
  false
);

alter table public.slabs alter column inventory_sequence set not null;

create unique index if not exists slabs_inventory_code_uidx on public.slabs (inventory_code);
create unique index if not exists slabs_prefix_sequence_uidx on public.slabs (inventory_prefix, inventory_sequence);
create index if not exists slabs_inventory_sequence_idx on public.slabs (inventory_sequence);

-- ── 4. Immutability ─────────────────────────────────────────────────────────
-- The generated code can never be written, but the prefix and sequence it is
-- built from must also never change once assigned.
create or replace function public.enforce_inventory_id_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.inventory_prefix is distinct from old.inventory_prefix
     or new.inventory_sequence is distinct from old.inventory_sequence then
    raise exception 'INVENTORY_ID_IMMUTABLE: inventory_prefix/inventory_sequence cannot change after creation'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists slabs_inventory_id_immutable on public.slabs;
create trigger slabs_inventory_id_immutable
  before update on public.slabs
  for each row execute function public.enforce_inventory_id_immutable();

-- ── 5. Resolver: parse a query, then find accessible slabs ─────────────────
-- parse_inventory_code is pure and deterministic:
--   'S0001' -> ('S', 1)   'R0012' -> ('R', 12)
--   '0001'  -> (null, 1)  '1'     -> (null, 1)
--   anything else -> no rows
create or replace function public.parse_inventory_code(p_query text)
returns table (prefix text, sequence integer)
language plpgsql
immutable
as $$
declare
  v text := upper(btrim(coalesce(p_query, '')));
begin
  if v ~ '^[A-Z][0-9]+$' then
    prefix := left(v, 1);
    sequence := substring(v from 2)::integer;
    return next;
  elsif v ~ '^[0-9]+$' then
    prefix := null;
    sequence := v::integer;
    return next;
  end if;
end;
$$;

-- resolve_slab_inventory returns the accessible slab(s) matching a query. A code
-- with a non-slab prefix (e.g. 'R0001') matches no slab. A bare number matches
-- the slab with that sequence regardless of prefix. Ownership is enforced: a
-- customer resolves only their own slabs; an admin resolves any.
create or replace function public.resolve_slab_inventory(p_query text)
returns setof public.slabs
language sql
stable
security definer
set search_path = public, auth
as $$
  select s.*
  from public.slabs s
  join public.parse_inventory_code(p_query) pc
    on s.inventory_sequence = pc.sequence
   and (pc.prefix is null or s.inventory_prefix = pc.prefix)
  where s.owner_id = (select auth.uid()) or public.is_admin((select auth.uid()));
$$;

revoke all on function public.parse_inventory_code(text) from public, anon;
grant execute on function public.parse_inventory_code(text) to authenticated, service_role;
revoke all on function public.resolve_slab_inventory(text) from public, anon;
grant execute on function public.resolve_slab_inventory(text) to authenticated, service_role;

-- ── 6. create_slab: assign the public code server-side ─────────────────────
-- Identical to the ownership-era definition, plus a permanent S-sequence code.
-- inventory_number and the image paths built from it are unchanged.
create or replace function public.create_slab(p jsonb, p_front_ext text, p_back_ext text)
returns public.slabs
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_owner text;
  v_uid uuid;
  v_grader text;
  v_cert text;
  v_grader_n text;
  v_cert_n text;
  v_existing integer;
  v_num integer;
  v_seq integer;
  v_front_ext text;
  v_back_ext text;
  v_front_path text;
  v_back_path text;
  v_row public.slabs;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  if not public.is_admin(v_uid) then
    select p2.account_status into v_owner
      from public.customer_profiles p2 where p2.id = v_uid;
    if v_owner is distinct from 'active' then
      raise exception 'NOT_AUTHORIZED' using errcode = '42501';
    end if;
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
     where owner_id = v_uid
       and grader_normalized = v_grader_n
       and certification_number_normalized = v_cert_n
     limit 1;
    if v_existing is not null then
      raise exception 'DUPLICATE_CERTIFICATION'
        using errcode = '23505', detail = v_existing::text;
    end if;
  end if;

  -- Two permanent, never-reused allocations: the internal number (storage/eBay
  -- key, unchanged) and the public S-sequence. Both come from atomic sequences.
  v_num := nextval('public.slab_inventory_seq');
  v_seq := nextval('public.slab_public_seq');
  v_front_path := 'slabs/' || v_num || '/front.' || v_front_ext;
  v_back_path := case when v_back_ext is null then null
    else 'slabs/' || v_num || '/back.' || v_back_ext end;

  insert into public.slabs (
    owner_id, inventory_number, inventory_prefix, inventory_sequence, card_name,
    final_value_cents, quick_sale_value_cents, replacement_value_cents,
    grader, grade, grade_label, certification_number, set_name, card_number, year,
    language, rarity, variation, label_description, label_accuracy,
    verification_status, valuation_confidence, valuation_provenance, duplicate_status,
    pricecharting_product_id, pricecharting_product_name, pricecharting_grade_field,
    pricecharting_value_cents, pricecharting_sales_volume, pricecharting_match_status,
    price_variance_percent, front_image_path, back_image_path, notes, date_valued
  ) values (
    v_uid, v_num, 'S', v_seq, nullif(btrim(p->>'card_name'), ''),
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
grant execute on function public.create_slab(jsonb, text, text) to authenticated;

comment on column public.slabs.inventory_code is 'Permanent public identifier (e.g. S0001). Immutable, never reused. Distinct from the internal inventory_number that keys storage + eBay SKUs.';
comment on function public.resolve_slab_inventory(text) is 'Resolve S0001 / 0001 / 1 to the accessible slab(s); ownership-scoped.';
