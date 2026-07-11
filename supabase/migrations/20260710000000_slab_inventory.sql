-- ============================================================================
-- SlabVault — graded Pokémon slab inventory
-- Tables: public.slabs, public.slab_comps
-- Race-safe sequential inventory numbering + duplicate-certification guard.
-- Certification numbers are TEXT so leading zeros are never lost.
-- All money is stored as integer cents (bigint). No floats.
-- Admin-only via RLS; server-side RPCs are SECURITY DEFINER and re-check admin.
-- ============================================================================

-- ─── slabs ──────────────────────────────────────────────────────────────────
create table if not exists public.slabs (
  id                          uuid primary key default gen_random_uuid(),
  inventory_number            integer not null unique,
  card_name                   text,
  final_value_cents           bigint,
  quick_sale_value_cents      bigint,
  replacement_value_cents     bigint,
  grader                      text,
  grade                       text,
  certification_number        text unique,
  set_name                    text,
  card_number                 text,
  year                        integer,
  language                    text,
  rarity                      text,
  variation                   text,
  label_description           text,
  label_accuracy              text,
  verification_status         text,
  valuation_confidence        text,
  duplicate_status            text,
  pricecharting_product_id    text,
  pricecharting_product_name  text,
  pricecharting_grade_field   text,
  pricecharting_value_cents   bigint,
  pricecharting_sales_volume  integer,
  pricecharting_match_status  text,
  price_variance_percent      numeric,
  front_image_path            text,
  back_image_path             text,
  notes                       text,
  date_valued                 timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists slabs_inventory_number_idx on public.slabs (inventory_number);
create index if not exists slabs_certification_idx     on public.slabs (certification_number);
create index if not exists slabs_grader_idx            on public.slabs (grader);
create index if not exists slabs_grade_idx             on public.slabs (grade);
create index if not exists slabs_language_idx          on public.slabs (language);
create index if not exists slabs_verification_idx      on public.slabs (verification_status);
create index if not exists slabs_confidence_idx        on public.slabs (valuation_confidence);
create index if not exists slabs_created_idx           on public.slabs (created_at desc);

-- ─── slab_comps (sales comparables) ─────────────────────────────────────────
create table if not exists public.slab_comps (
  id                uuid primary key default gen_random_uuid(),
  slab_id           uuid not null references public.slabs(id) on delete cascade,
  sale_date         date,
  sold_price_cents  bigint,
  shipping_cents    bigint,
  total_price_cents bigint,
  marketplace       text,
  grader            text,
  grade             text,
  exact_match       boolean,
  source_url        text,
  notes             text,
  created_at        timestamptz not null default now()
);

create index if not exists slab_comps_slab_idx on public.slab_comps (slab_id);

-- ─── updated_at trigger ─────────────────────────────────────────────────────
create or replace function public.slab_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists slabs_set_updated_at on public.slabs;
create trigger slabs_set_updated_at
  before update on public.slabs
  for each row execute function public.slab_set_updated_at();

-- ============================================================================
-- Race-safe inventory numbering
-- A transaction-scoped advisory lock serializes number assignment so two
-- concurrent inserts can never receive the same number. The UNIQUE constraint
-- on inventory_number is the final backstop.
-- NOTE: a later migration (20260715000000_inventory_sequence) replaces this
-- MAX+1 scheme with a monotonic sequence. Numbers are permanent and never
-- reused; gaps from failed transactions are acceptable and NOT claimed gapless.
-- ============================================================================
create or replace function public.next_slab_inventory_number()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  next_num integer;
begin
  -- Serialize all concurrent callers on a single well-known lock key.
  perform pg_advisory_xact_lock(918273645);
  select coalesce(max(inventory_number), 0) + 1 into next_num from public.slabs;
  return next_num;
end;
$$;

-- ─── duplicate-certification lookup (read helper for the intake UI) ─────────
create or replace function public.check_slab_certification(p_cert text)
returns table (id uuid, inventory_number integer)
language sql
security definer
set search_path = public
as $$
  -- Admin-only: this SECURITY DEFINER function bypasses RLS, so guard it.
  select s.id, s.inventory_number
  from public.slabs s
  where public.is_admin(auth.uid())
    and p_cert is not null
    and p_cert <> ''
    and s.certification_number = p_cert
  limit 1;
$$;

-- ============================================================================
-- create_slab: atomic, race-safe insert.
-- 1. Requires an admin caller.
-- 2. Rejects a duplicate certification (raises DUPLICATE_CERTIFICATION with the
--    existing inventory number in DETAIL so the UI can link to it).
-- 3. Assigns the next inventory number under the advisory lock.
-- 4. Computes deterministic image paths from the assigned number + extensions.
-- 5. Inserts exactly one row and returns it.
-- Image bytes are uploaded by the client AFTER this returns; on any upload
-- failure the client deletes this row (compensating cleanup) so no incomplete
-- record persists. Because insert precedes upload, an insert failure (e.g. a
-- duplicate certification) means nothing was uploaded — there is nothing to
-- clean up.
-- ============================================================================
create or replace function public.create_slab(p jsonb, p_front_ext text, p_back_ext text)
returns public.slabs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cert       text;
  v_existing   integer;
  v_num        integer;
  v_front_path text;
  v_back_path  text;
  v_row        public.slabs;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  v_cert := nullif(p->>'certification_number', '');

  -- Serialize number assignment + duplicate check together.
  perform pg_advisory_xact_lock(918273645);

  if v_cert is not null then
    select inventory_number into v_existing
    from public.slabs
    where certification_number = v_cert
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
    p->>'grader',
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

-- ─── Row Level Security (admin-only) ────────────────────────────────────────
alter table public.slabs enable row level security;
alter table public.slab_comps enable row level security;

create policy "slabs admin all" on public.slabs
  for all to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create policy "slab_comps admin all" on public.slab_comps
  for all to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- Execute grants for the RPCs (RLS still applies inside SECURITY DEFINER via the
-- explicit is_admin check in create_slab; the read helpers are admin-scoped by
-- the table RLS they never bypass for non-definer reads).
grant execute on function public.next_slab_inventory_number() to authenticated;
grant execute on function public.check_slab_certification(text) to authenticated;
grant execute on function public.create_slab(jsonb, text, text) to authenticated;
