-- GradedCardValue.com — PriceCharting Marketplace lifecycle.
--
-- Adds an admin-only, auditable local mirror of marketplace offers. A sold
-- offer creates exactly one sales comparable and updates the linked slab in the
-- same transaction. Buyer PII and provider credentials are intentionally never
-- stored in these tables.

alter table public.slabs
  add column if not exists inventory_status text not null default 'active',
  add column if not exists cost_basis_cents bigint,
  add column if not exists acquired_at date,
  add column if not exists sold_at timestamptz,
  add column if not exists sold_price_cents bigint,
  add column if not exists sale_shipping_cents bigint;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'slabs_inventory_status_chk') then
    alter table public.slabs add constraint slabs_inventory_status_chk
      check (inventory_status in ('draft', 'active', 'listed', 'sold', 'archived'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_cost_basis_nonnegative_chk') then
    alter table public.slabs add constraint slabs_cost_basis_nonnegative_chk
      check (cost_basis_cents is null or cost_basis_cents >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_sold_price_nonnegative_chk') then
    alter table public.slabs add constraint slabs_sold_price_nonnegative_chk
      check (sold_price_cents is null or sold_price_cents >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_sale_shipping_nonnegative_chk') then
    alter table public.slabs add constraint slabs_sale_shipping_nonnegative_chk
      check (sale_shipping_cents is null or sale_shipping_cents >= 0);
  end if;
end $$;

alter table public.slab_comps
  add column if not exists source_offer_id text,
  add column if not exists source_kind text;

create unique index if not exists slab_comps_source_offer_unique_idx
  on public.slab_comps (source_offer_id)
  where source_offer_id is not null;

create table if not exists public.pricecharting_offers (
  id                         uuid primary key default gen_random_uuid(),
  slab_id                    uuid not null references public.slabs(id) on delete cascade,
  offer_id                   text not null unique,
  pricecharting_offer_id     text generated always as (offer_id) stored,
  product_id                 text,
  pricecharting_product_id   text generated always as (product_id) stored,
  product_name               text,
  sku                        text,
  condition_id               integer,
  offer_status               text not null default 'available',
  cost_basis_cents           bigint,
  price_min_cents            bigint,
  minimum_price_cents        bigint generated always as (price_min_cents) stored,
  price_max_cents            bigint,
  maximum_price_cents        bigint generated always as (price_max_cents) stored,
  sale_price_cents           bigint,
  shipping_premium_cents     bigint,
  shipped                    boolean,
  refunded                   boolean,
  tracking_status            text,
  feedback_status            text,
  tracking_number            text,
  listed_at                  timestamptz,
  sold_at                    timestamptz,
  shipped_at                 timestamptz,
  ended_at                   timestamptz,
  refunded_at                timestamptz,
  raw_response               jsonb not null default '{}'::jsonb,
  last_synced_at             timestamptz not null default now(),
  created_by                 uuid references auth.users(id) on delete set null,
  updated_by                 uuid references auth.users(id) on delete set null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint pricecharting_offers_status_chk check (
    offer_status in ('available', 'collection', 'sold', 'ended', 'refunded', 'unknown')
  ),
  constraint pricecharting_offers_money_chk check (
    (cost_basis_cents is null or cost_basis_cents >= 0) and
    (price_min_cents is null or price_min_cents >= 0) and
    (price_max_cents is null or price_max_cents >= 0) and
    (sale_price_cents is null or sale_price_cents >= 0) and
    (shipping_premium_cents is null or shipping_premium_cents >= 0)
  )
);

create unique index if not exists pricecharting_offers_external_id_uidx
  on public.pricecharting_offers (pricecharting_offer_id);

create index if not exists pricecharting_offers_slab_idx
  on public.pricecharting_offers (slab_id, updated_at desc);
create index if not exists pricecharting_offers_status_idx
  on public.pricecharting_offers (offer_status, last_synced_at desc);
create unique index if not exists pricecharting_offers_active_sku_unique_idx
  on public.pricecharting_offers (lower(sku))
  where sku is not null and offer_status in ('available', 'collection');

create table if not exists public.pricecharting_offer_events (
  id             bigint generated always as identity primary key,
  offer_id       uuid not null references public.pricecharting_offers(id) on delete cascade,
  slab_id        uuid not null references public.slabs(id) on delete cascade,
  event_type     text not null,
  event_at       timestamptz not null default now(),
  actor_user_id  uuid references auth.users(id) on delete set null,
  detail         jsonb not null default '{}'::jsonb,
  constraint pricecharting_offer_events_type_chk check (
    event_type in ('published', 'edited', 'synced', 'sold', 'shipped', 'feedback', 'ended', 'refunded')
  )
);

create index if not exists pricecharting_offer_events_offer_idx
  on public.pricecharting_offer_events (offer_id, event_at desc);

create table if not exists public.pricecharting_marketplace_settings (
  singleton       boolean primary key default true check (singleton),
  seller_id       text,
  sync_enabled    boolean not null default false,
  last_synced_at  timestamptz,
  updated_by      uuid references auth.users(id) on delete set null,
  updated_at      timestamptz not null default now()
);

insert into public.pricecharting_marketplace_settings (singleton)
values (true)
on conflict (singleton) do nothing;

create table if not exists public.pricecharting_sync_runs (
  id             uuid primary key default gen_random_uuid(),
  trigger_kind   text not null default 'manual',
  status         text not null default 'running',
  offers_seen    integer not null default 0,
  offers_updated integer not null default 0,
  comps_created  integer not null default 0,
  error_message  text,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  created_by     uuid references auth.users(id) on delete set null,
  constraint pricecharting_sync_runs_trigger_chk check (trigger_kind in ('manual', 'scheduled', 'csv')),
  constraint pricecharting_sync_runs_status_chk check (status in ('running', 'success', 'partial', 'failed'))
);

alter table public.pricecharting_offers enable row level security;
alter table public.pricecharting_offer_events enable row level security;
alter table public.pricecharting_marketplace_settings enable row level security;
alter table public.pricecharting_sync_runs enable row level security;

create policy "pricecharting_offers admin all" on public.pricecharting_offers
  for all to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create policy "pricecharting_offer_events admin read" on public.pricecharting_offer_events
  for select to authenticated
  using (public.is_admin(auth.uid()));
create policy "pricecharting_offer_events admin insert" on public.pricecharting_offer_events
  for insert to authenticated
  with check (public.is_admin(auth.uid()));

create policy "pricecharting_marketplace_settings admin all" on public.pricecharting_marketplace_settings
  for all to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create policy "pricecharting_sync_runs admin all" on public.pricecharting_sync_runs
  for all to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

grant select, insert, update, delete on public.pricecharting_offers to authenticated;
grant select, insert on public.pricecharting_offer_events to authenticated;
grant select, insert, update, delete on public.pricecharting_marketplace_settings to authenticated;
grant select, insert, update, delete on public.pricecharting_sync_runs to authenticated;
grant usage, select on sequence public.pricecharting_offer_events_id_seq to authenticated;

grant all on public.pricecharting_offers to service_role;
grant all on public.pricecharting_offer_events to service_role;
grant all on public.pricecharting_marketplace_settings to service_role;
grant all on public.pricecharting_sync_runs to service_role;
grant usage, select on sequence public.pricecharting_offer_events_id_seq to service_role;

-- Apply a token-free, PII-free offer snapshot. The Edge Function constructs the
-- allowlisted snapshot; this RPC derives the actor from auth.uid() and performs
-- the offer mirror, event log, slab lifecycle update, and sold comp atomically.
create or replace function public.apply_pricecharting_offer_snapshot(
  p_slab_id uuid,
  p_snapshot jsonb,
  p_event_type text default 'synced'
) returns public.pricecharting_offers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_offer_id text := nullif(trim(p_snapshot->>'offer_id'), '');
  v_status text := lower(coalesce(nullif(p_snapshot->>'status', ''), 'unknown'));
  v_previous_status text;
  v_row public.pricecharting_offers;
  v_sold_at timestamptz;
  v_event text := lower(coalesce(nullif(p_event_type, ''), 'synced'));
begin
  if not public.is_admin(v_actor) and auth.role() <> 'service_role' then
    raise exception 'not authorized to sync a PriceCharting offer' using errcode = '42501';
  end if;
  if v_offer_id is null then
    raise exception 'offer_id is required' using errcode = '22023';
  end if;
  if v_status not in ('available', 'collection', 'sold', 'ended', 'refunded', 'unknown') then
    v_status := 'unknown';
  end if;
  if v_event not in ('published', 'edited', 'synced', 'sold', 'shipped', 'feedback', 'ended', 'refunded') then
    raise exception 'invalid marketplace event type' using errcode = '22023';
  end if;

  select offer_status into v_previous_status
  from public.pricecharting_offers
  where offer_id = v_offer_id;

  begin
    v_sold_at := nullif(p_snapshot->>'sold_at', '')::timestamptz;
  exception when others then
    v_sold_at := null;
  end;

  insert into public.pricecharting_offers (
    slab_id, offer_id, product_id, product_name, sku, condition_id,
    offer_status, cost_basis_cents, price_min_cents, price_max_cents,
    sale_price_cents, shipping_premium_cents, shipped, refunded,
    feedback_status, tracking_number, listed_at, sold_at, shipped_at, ended_at,
    last_synced_at, created_by, updated_by
  ) values (
    p_slab_id, v_offer_id, nullif(p_snapshot->>'product_id', ''), nullif(p_snapshot->>'product_name', ''),
    nullif(p_snapshot->>'sku', ''), nullif(p_snapshot->>'condition_id', '')::integer,
    v_status, nullif(p_snapshot->>'cost_basis_cents', '')::bigint,
    nullif(p_snapshot->>'price_min_cents', '')::bigint, nullif(p_snapshot->>'price_max_cents', '')::bigint,
    nullif(p_snapshot->>'sale_price_cents', '')::bigint, nullif(p_snapshot->>'shipping_premium_cents', '')::bigint,
    nullif(p_snapshot->>'shipped', '')::boolean, nullif(p_snapshot->>'refunded', '')::boolean,
    nullif(p_snapshot->>'feedback_status', ''), nullif(p_snapshot->>'tracking_number', ''),
    nullif(p_snapshot->>'listed_at', '')::timestamptz, v_sold_at,
    nullif(p_snapshot->>'shipped_at', '')::timestamptz, nullif(p_snapshot->>'ended_at', '')::timestamptz,
    now(), v_actor, v_actor
  )
  on conflict (offer_id) do update set
    slab_id = excluded.slab_id,
    product_id = coalesce(excluded.product_id, pricecharting_offers.product_id),
    product_name = coalesce(excluded.product_name, pricecharting_offers.product_name),
    sku = coalesce(excluded.sku, pricecharting_offers.sku),
    condition_id = coalesce(excluded.condition_id, pricecharting_offers.condition_id),
    offer_status = excluded.offer_status,
    cost_basis_cents = coalesce(excluded.cost_basis_cents, pricecharting_offers.cost_basis_cents),
    price_min_cents = coalesce(excluded.price_min_cents, pricecharting_offers.price_min_cents),
    price_max_cents = coalesce(excluded.price_max_cents, pricecharting_offers.price_max_cents),
    sale_price_cents = coalesce(excluded.sale_price_cents, pricecharting_offers.sale_price_cents),
    shipping_premium_cents = coalesce(excluded.shipping_premium_cents, pricecharting_offers.shipping_premium_cents),
    shipped = coalesce(excluded.shipped, pricecharting_offers.shipped),
    refunded = coalesce(excluded.refunded, pricecharting_offers.refunded),
    feedback_status = coalesce(excluded.feedback_status, pricecharting_offers.feedback_status),
    tracking_number = coalesce(excluded.tracking_number, pricecharting_offers.tracking_number),
    listed_at = coalesce(excluded.listed_at, pricecharting_offers.listed_at),
    sold_at = coalesce(excluded.sold_at, pricecharting_offers.sold_at),
    shipped_at = coalesce(excluded.shipped_at, pricecharting_offers.shipped_at),
    ended_at = coalesce(excluded.ended_at, pricecharting_offers.ended_at),
    refunded_at = case
      when excluded.offer_status = 'refunded' then coalesce(pricecharting_offers.refunded_at, now())
      else pricecharting_offers.refunded_at
    end,
    last_synced_at = now(), updated_by = v_actor, updated_at = now()
  returning * into v_row;

  insert into public.pricecharting_offer_events (offer_id, slab_id, event_type, actor_user_id, detail)
  values (
    v_row.id, p_slab_id,
    case when v_previous_status is distinct from v_status and v_status in ('sold', 'ended', 'refunded')
      then v_status else v_event end,
    v_actor,
    jsonb_strip_nulls(jsonb_build_object('previous_status', v_previous_status, 'status', v_status))
  );

  if v_status in ('available', 'collection') then
    update public.slabs set
      inventory_status = 'listed',
      cost_basis_cents = coalesce(v_row.cost_basis_cents, cost_basis_cents)
    where id = p_slab_id and inventory_status <> 'sold';
  elsif v_status = 'sold' then
    update public.slabs set
      inventory_status = 'sold',
      cost_basis_cents = coalesce(v_row.cost_basis_cents, cost_basis_cents),
      sold_at = coalesce(v_row.sold_at, now()),
      sold_price_cents = v_row.sale_price_cents,
      sale_shipping_cents = v_row.shipping_premium_cents
    where id = p_slab_id;

    insert into public.slab_comps (
      slab_id, sale_date, sold_price_cents, shipping_cents, total_price_cents,
      marketplace, grader, grade, exact_match, notes, source_offer_id, source_kind
    )
    select
      s.id, coalesce(v_row.sold_at, now())::date, v_row.sale_price_cents,
      coalesce(v_row.shipping_premium_cents, 0),
      coalesce(v_row.sale_price_cents, 0) + coalesce(v_row.shipping_premium_cents, 0),
      'PriceCharting', s.grader, s.grade, true,
      'Imported automatically from completed PriceCharting marketplace offer.',
      v_offer_id, 'pricecharting_marketplace'
    from public.slabs s where s.id = p_slab_id
    on conflict (source_offer_id) where source_offer_id is not null do nothing;
  elsif v_status = 'refunded' then
    update public.slabs set inventory_status = 'active'
    where id = p_slab_id and inventory_status = 'sold';
  elsif v_status = 'ended' then
    update public.slabs set inventory_status = 'active'
    where id = p_slab_id and inventory_status = 'listed';
  end if;

  return v_row;
end;
$$;

revoke all on function public.apply_pricecharting_offer_snapshot(uuid, jsonb, text) from public;
revoke all on function public.apply_pricecharting_offer_snapshot(uuid, jsonb, text) from anon;
grant execute on function public.apply_pricecharting_offer_snapshot(uuid, jsonb, text) to authenticated;
grant execute on function public.apply_pricecharting_offer_snapshot(uuid, jsonb, text) to service_role;

comment on table public.pricecharting_offers is
  'Admin-only token-free, buyer-PII-free mirror of PriceCharting marketplace offers.';
comment on table public.pricecharting_offer_events is
  'Append-only admin audit history for marketplace lifecycle changes.';
