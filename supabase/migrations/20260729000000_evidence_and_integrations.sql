-- GradedCardValue.com — evidence provenance, immutable valuations, shared
-- integration records, and eBay-ready data separation.

-- Move the existing explicit allowlist into immutable app_metadata, then make
-- app_metadata the sole admin authority. user_metadata is intentionally ignored.
update auth.users u
set raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb)
  || jsonb_build_object('graded_card_value_admin', true)
where exists (select 1 from public.slab_admins a where a.user_id = u.id)
  and coalesce((u.raw_app_meta_data->>'graded_card_value_admin')::boolean, false) is not true;

create or replace function public.is_admin(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from auth.users u
    where u.id = _user_id
      and coalesce((u.raw_app_meta_data->>'graded_card_value_admin')::boolean, false)
  );
$$;
revoke all on function public.is_admin(uuid) from public, anon;
grant execute on function public.is_admin(uuid) to authenticated, service_role;

alter table public.slabs
  add column if not exists visual_identity_status text not null default 'not_checked',
  add column if not exists certification_verification_status text not null default 'not_checked',
  add column if not exists valuation_status text not null default 'unavailable';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'slabs_visual_identity_status_chk') then
    alter table public.slabs add constraint slabs_visual_identity_status_chk check (
      visual_identity_status in ('not_checked', 'needs_review', 'verified', 'rejected')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_cert_verification_status_chk') then
    alter table public.slabs add constraint slabs_cert_verification_status_chk check (
      certification_verification_status in ('not_checked', 'unsupported', 'verified', 'failed')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_valuation_status_chk') then
    alter table public.slabs add constraint slabs_valuation_status_chk check (
      valuation_status in ('exact_api_tier', 'compatible_api_tier', 'manual', 'unavailable', 'needs_review')
    );
  end if;
end $$;

create or replace function public.sync_source_statuses()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  new.visual_identity_status := case new.visual_confirmation_status
    when 'user_confirmed' then 'verified'
    when 'user_rejected' then 'rejected'
    when 'metadata_auto_confirmed' then 'needs_review'
    else coalesce(new.visual_identity_status, 'not_checked') end;
  -- No authorized grader database is integrated. OCR/photo confirmation must
  -- never promote certification_verification_status.
  if new.certification_verification_status is null then new.certification_verification_status := 'not_checked'; end if;
  return new;
end;
$$;
drop trigger if exists slabs_sync_source_statuses on public.slabs;
create trigger slabs_sync_source_statuses before insert or update of visual_confirmation_status on public.slabs
  for each row execute function public.sync_source_statuses();

create table if not exists public.slab_images (
  id            uuid primary key default gen_random_uuid(),
  slab_id       uuid not null references public.slabs(id) on delete cascade,
  image_role    text not null,
  storage_path  text not null unique,
  mime_type     text not null,
  width         integer,
  height        integer,
  sha256        text not null,
  is_original   boolean not null default true,
  created_by    uuid references auth.users(id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  constraint slab_images_role_chk check (image_role in ('front', 'back', 'label', 'collector_number', 'certification_number', 'card_face')),
  constraint slab_images_dimensions_chk check ((width is null or width > 0) and (height is null or height > 0)),
  constraint slab_images_sha256_chk check (sha256 ~ '^[0-9a-f]{64}$')
);

create table if not exists public.image_derivatives (
  id                 uuid primary key default gen_random_uuid(),
  slab_image_id      uuid not null references public.slab_images(id) on delete cascade,
  derivative_type    text not null,
  storage_path       text not null unique,
  transform_manifest jsonb not null,
  width              integer not null check (width > 0),
  height             integer not null check (height > 0),
  sha256             text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at         timestamptz not null default now(),
  unique (slab_image_id, derivative_type, sha256)
);

create table if not exists public.ai_analysis_runs (
  id                 uuid primary key default gen_random_uuid(),
  slab_id            uuid references public.slabs(id) on delete cascade,
  provider           text not null,
  model              text not null,
  schema_version     text not null,
  analysis_type      text not null,
  status             text not null,
  request_id         text,
  input_image_ids    uuid[] not null default '{}',
  structured_result  jsonb,
  usage              jsonb,
  latency_ms         integer check (latency_ms is null or latency_ms >= 0),
  error_code         text,
  created_at         timestamptz not null default now(),
  constraint ai_analysis_runs_status_chk check (status in ('running', 'succeeded', 'failed', 'needs_review'))
);

create table if not exists public.ai_field_evidence (
  id                uuid primary key default gen_random_uuid(),
  analysis_run_id   uuid not null references public.ai_analysis_runs(id) on delete cascade,
  slab_id           uuid references public.slabs(id) on delete cascade,
  field_name        text not null,
  value             text,
  normalized_value  text,
  confidence        numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  image_id          uuid references public.slab_images(id) on delete set null,
  derivative_id     uuid references public.image_derivatives(id) on delete set null,
  bounding_box      jsonb,
  alternatives      jsonb not null default '[]'::jsonb,
  readability       text,
  created_at        timestamptz not null default now()
);

create table if not exists public.pricecharting_products (
  product_id        text primary key,
  product_name      text not null,
  console_name      text,
  raw_response      jsonb not null,
  first_seen_at     timestamptz not null default now(),
  last_refreshed_at timestamptz not null default now()
);

create table if not exists public.slab_product_candidates (
  id                       uuid primary key default gen_random_uuid(),
  slab_id                  uuid not null references public.slabs(id) on delete cascade,
  pricecharting_product_id text not null references public.pricecharting_products(product_id),
  candidate_rank           integer not null check (candidate_rank > 0),
  score                    numeric not null,
  gate_status              text not null,
  rejection_reasons        jsonb not null default '[]'::jsonb,
  metadata_agreement       jsonb not null default '{}'::jsonb,
  artwork_agreement        jsonb,
  created_at               timestamptz not null default now(),
  unique (slab_id, pricecharting_product_id, created_at)
);

create table if not exists public.slab_product_links (
  id                       uuid primary key default gen_random_uuid(),
  slab_id                  uuid not null references public.slabs(id) on delete cascade,
  pricecharting_product_id text not null references public.pricecharting_products(product_id),
  link_status              text not null,
  link_method              text not null,
  confirmed_by             uuid references auth.users(id) on delete set null,
  confirmed_at             timestamptz,
  override_reason          text,
  created_at               timestamptz not null default now(),
  constraint slab_product_links_status_chk check (link_status in ('candidate', 'confirmed', 'rejected', 'superseded')),
  constraint slab_product_links_override_chk check (link_method <> 'override' or nullif(btrim(override_reason), '') is not null)
);
create unique index if not exists slab_product_links_one_confirmed_idx
  on public.slab_product_links (slab_id) where link_status = 'confirmed';

create table if not exists public.valuation_snapshots (
  id                         uuid primary key default gen_random_uuid(),
  slab_id                    uuid not null references public.slabs(id) on delete cascade,
  pricecharting_product_id   text references public.pricecharting_products(product_id),
  source                    text not null default 'PRICECHARTING',
  source_field              text,
  tier_relationship         text not null,
  guide_value_cents         bigint check (guide_value_cents is null or guide_value_cents >= 0),
  quick_sale_value_cents    bigint check (quick_sale_value_cents is null or quick_sale_value_cents >= 0),
  replacement_value_cents   bigint check (replacement_value_cents is null or replacement_value_cents >= 0),
  currency                  text not null default 'USD',
  confidence                text not null,
  raw_response              jsonb,
  valued_at                 timestamptz not null default now(),
  constraint valuation_snapshots_tier_chk check (tier_relationship in ('EXACT', 'COMPATIBLE', 'MANUAL', 'UNAVAILABLE')),
  constraint valuation_snapshots_confidence_chk check (confidence in ('HIGH', 'MEDIUM', 'MANUAL', 'UNAVAILABLE'))
);
create index if not exists valuation_snapshots_slab_idx on public.valuation_snapshots (slab_id, valued_at desc);

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
    insert into public.pricecharting_products (product_id, product_name, console_name, raw_response, last_refreshed_at)
    values (
      new.pricecharting_product_id, coalesce(new.pricecharting_product_name, 'Unknown PriceCharting product'),
      new.pricecharting_raw->>'console_or_category', coalesce(new.pricecharting_raw, '{}'::jsonb), new.pricecharting_priced_at
    ) on conflict (product_id) do update set
      product_name = excluded.product_name, console_name = excluded.console_name,
      raw_response = excluded.raw_response, last_refreshed_at = excluded.last_refreshed_at;
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
  update public.slabs set valuation_status = case v_relation
    when 'EXACT' then 'exact_api_tier' when 'COMPATIBLE' then 'compatible_api_tier'
    when 'MANUAL' then 'manual' else 'unavailable' end
  where id = new.id;
  return new;
end;
$$;
drop trigger if exists slabs_capture_valuation_snapshot on public.slabs;
create trigger slabs_capture_valuation_snapshot
  after update of pricecharting_priced_at on public.slabs
  for each row execute function public.capture_slab_valuation_snapshot();

create or replace function public.capture_confirmed_product_link()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.pricecharting_product_id is null or new.product_confirmed_at is null then return new; end if;
  insert into public.pricecharting_products (product_id, product_name, console_name, raw_response)
  values (new.pricecharting_product_id, coalesce(new.pricecharting_product_name, 'Unknown PriceCharting product'), null, '{}'::jsonb)
  on conflict (product_id) do nothing;
  update public.slab_product_links set link_status = 'superseded'
    where slab_id = new.id and link_status = 'confirmed' and pricecharting_product_id <> new.pricecharting_product_id;
  insert into public.slab_product_links (
    slab_id, pricecharting_product_id, link_status, link_method, confirmed_by, confirmed_at
  ) values (
    new.id, new.pricecharting_product_id, 'confirmed', coalesce(new.product_confirmation_source, 'search_manual'),
    new.visual_confirmation_by, new.product_confirmed_at
  ) on conflict (slab_id) where link_status = 'confirmed' do update set
    pricecharting_product_id = excluded.pricecharting_product_id,
    link_method = excluded.link_method, confirmed_by = excluded.confirmed_by,
    confirmed_at = excluded.confirmed_at;
  return new;
end;
$$;
drop trigger if exists slabs_capture_confirmed_product_link on public.slabs;
create trigger slabs_capture_confirmed_product_link
  after update of product_confirmed_at, pricecharting_product_id on public.slabs
  for each row execute function public.capture_confirmed_product_link();

create table if not exists public.sold_comps (
  id                    uuid primary key default gen_random_uuid(),
  slab_id               uuid references public.slabs(id) on delete set null,
  source                text not null,
  external_sale_id      text not null,
  pricecharting_product_id text,
  sold_price_cents      bigint not null check (sold_price_cents >= 0),
  shipping_cents        bigint check (shipping_cents is null or shipping_cents >= 0),
  fees_cents            bigint check (fees_cents is null or fees_cents >= 0),
  currency              text not null default 'USD',
  sold_at               timestamptz not null,
  raw_response          jsonb,
  created_at            timestamptz not null default now(),
  unique (source, external_sale_id)
);

create or replace function public.capture_pricecharting_sold_comp()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.offer_status = 'sold' and new.sale_price_cents is not null then
    insert into public.sold_comps (
      slab_id, source, external_sale_id, pricecharting_product_id,
      sold_price_cents, shipping_cents, currency, sold_at, raw_response
    ) values (
      new.slab_id, 'PRICECHARTING_MARKETPLACE', new.offer_id, new.product_id,
      new.sale_price_cents, new.shipping_premium_cents, 'USD',
      coalesce(new.sold_at, now()),
      jsonb_strip_nulls(jsonb_build_object('offer_status', new.offer_status, 'sku', new.sku))
    ) on conflict (source, external_sale_id) do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists pricecharting_offer_capture_sold_comp on public.pricecharting_offers;
create trigger pricecharting_offer_capture_sold_comp
  after insert or update of offer_status, sale_price_cents on public.pricecharting_offers
  for each row execute function public.capture_pricecharting_sold_comp();

create table if not exists public.marketplace_events (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null,
  external_id     text,
  idempotency_key text not null unique,
  event_type      text not null,
  slab_id         uuid references public.slabs(id) on delete set null,
  safe_payload    jsonb not null default '{}'::jsonb,
  processed_at    timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists public.webhook_inbox (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null,
  idempotency_key text not null unique,
  event_type      text,
  signature_valid boolean not null default false,
  safe_headers    jsonb not null default '{}'::jsonb,
  payload_sha256  text not null,
  status          text not null default 'pending',
  attempt_count   integer not null default 0,
  next_attempt_at timestamptz,
  processed_at    timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists public.integration_errors (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null,
  operation       text not null,
  error_code      text,
  safe_message    text not null,
  retryable       boolean not null default false,
  attempt_count   integer not null default 1,
  next_attempt_at timestamptz,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists public.audit_log (
  id              bigint generated always as identity primary key,
  actor_user_id   uuid references auth.users(id) on delete set null,
  action          text not null,
  entity_type     text not null,
  entity_id       text,
  source          text not null,
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

-- Public, non-sensitive eBay account/listing state. OAuth credentials, buyers,
-- orders, financial transactions, and fulfillment addresses live in private.
create table if not exists public.ebay_accounts (
  id                    uuid primary key default gen_random_uuid(),
  ebay_user_id          text not null unique,
  marketplace_id        text,
  display_label         text,
  connection_status     text not null default 'disconnected',
  privilege_status      text,
  authorization_expires_at timestamptz,
  last_synced_at        timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create table if not exists public.ebay_inventory_locations (
  id uuid primary key default gen_random_uuid(),
  ebay_account_id uuid not null references public.ebay_accounts(id) on delete cascade,
  merchant_location_key text not null,
  status text,
  raw_enum_value text,
  last_synced_at timestamptz,
  unique (ebay_account_id, merchant_location_key)
);
create table if not exists public.ebay_business_policies (
  id uuid primary key default gen_random_uuid(),
  ebay_account_id uuid not null references public.ebay_accounts(id) on delete cascade,
  policy_id text not null,
  policy_type text not null,
  name text,
  marketplace_id text,
  last_synced_at timestamptz,
  unique (ebay_account_id, policy_id)
);
create table if not exists public.ebay_listing_mappings (
  id uuid primary key default gen_random_uuid(),
  slab_id uuid not null references public.slabs(id) on delete cascade,
  ebay_account_id uuid not null references public.ebay_accounts(id) on delete cascade,
  sku text not null,
  offer_id text,
  listing_id text,
  listing_status text not null default 'draft',
  asking_price_cents bigint check (asking_price_cents is null or asking_price_cents >= 0),
  currency text not null default 'USD',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (ebay_account_id, sku),
  unique (ebay_account_id, offer_id)
);
create table if not exists public.ebay_notifications (
  id uuid primary key default gen_random_uuid(),
  ebay_account_id uuid references public.ebay_accounts(id) on delete cascade,
  notification_id text not null unique,
  topic text not null,
  status text not null,
  payload_sha256 text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create table if not exists public.ebay_sync_cursors (
  id uuid primary key default gen_random_uuid(),
  ebay_account_id uuid not null references public.ebay_accounts(id) on delete cascade,
  resource_type text not null,
  cursor_value text,
  next_sync_at timestamptz,
  last_synced_at timestamptz,
  unique (ebay_account_id, resource_type)
);
create table if not exists public.ebay_api_runs (
  id uuid primary key default gen_random_uuid(),
  ebay_account_id uuid references public.ebay_accounts(id) on delete cascade,
  operation text not null,
  status text not null,
  http_status integer,
  request_id text,
  latency_ms integer,
  error_code text,
  created_at timestamptz not null default now()
);

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.ebay_oauth_credentials (
  ebay_account_id uuid primary key references public.ebay_accounts(id) on delete cascade,
  refresh_token_encrypted text not null,
  refresh_token_expires_at timestamptz,
  scopes text[] not null default '{}',
  rotated_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists private.ebay_oauth_states (
  state_hash text primary key,
  requested_by uuid not null references auth.users(id) on delete cascade,
  redirect_after text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists private.ebay_orders (
  id uuid primary key default gen_random_uuid(),
  ebay_account_id uuid not null references public.ebay_accounts(id) on delete cascade,
  order_id text not null,
  order_status text,
  buyer_data jsonb,
  pricing_summary jsonb,
  raw_response jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ebay_account_id, order_id)
);
create table if not exists private.ebay_order_line_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references private.ebay_orders(id) on delete cascade,
  line_item_id text not null,
  slab_id uuid references public.slabs(id) on delete set null,
  sku text,
  listing_id text,
  quantity integer,
  line_total jsonb,
  raw_response jsonb,
  unique (order_id, line_item_id)
);
create table if not exists private.ebay_fulfillments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references private.ebay_orders(id) on delete cascade,
  fulfillment_id text,
  tracking_number text,
  shipping_carrier_code text,
  shipped_at timestamptz,
  raw_response jsonb,
  unique (order_id, fulfillment_id)
);
create table if not exists private.ebay_financial_transactions (
  id uuid primary key default gen_random_uuid(),
  ebay_account_id uuid not null references public.ebay_accounts(id) on delete cascade,
  transaction_id text not null,
  order_id text,
  transaction_type text,
  transaction_status text,
  amount jsonb,
  fee_basis_amount jsonb,
  raw_response jsonb not null,
  occurred_at timestamptz,
  unique (ebay_account_id, transaction_id)
);

-- RLS and identical app_metadata-admin ownership predicates for every exposed
-- integration/evidence table.
do $$
declare
  t text;
begin
  foreach t in array array[
    'slab_images','image_derivatives','ai_analysis_runs','ai_field_evidence',
    'pricecharting_products','slab_product_candidates','slab_product_links',
    'valuation_snapshots','sold_comps','marketplace_events','webhook_inbox',
    'integration_errors','audit_log','ebay_accounts','ebay_inventory_locations',
    'ebay_business_policies','ebay_listing_mappings','ebay_notifications',
    'ebay_sync_cursors','ebay_api_runs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()))', t || '_admin_all', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
grant usage, select on sequence public.audit_log_id_seq to authenticated, service_role;

-- Append-only records cannot be rewritten by browser clients even when admin.
revoke update, delete on public.ai_analysis_runs, public.ai_field_evidence,
  public.valuation_snapshots, public.sold_comps, public.marketplace_events,
  public.webhook_inbox, public.audit_log from authenticated;

comment on column public.slabs.certification_verification_status is
  'Certification-database status only. Photo/OCR confirmation must never set this to verified.';
comment on table private.ebay_oauth_credentials is
  'Server-only encrypted eBay OAuth refresh credentials; never exposed through the Data API.';

-- The repository previously staged an optional Apify/CGC population importer.
-- There is no authorized CGC API in this build, so make the effective database
-- state read/write-inaccessible without destroying any historical rows.
revoke all on public.cgc_population_sets, public.cgc_population_cards,
  public.cgc_population_import_runs from authenticated, anon;
revoke all on function public.cgc_claim_import_run(uuid, uuid, text, jsonb, numeric)
  from public, anon, authenticated, service_role;

create or replace function public.link_ai_analysis_run(p_run_id uuid, p_slab_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'not authorized to link analysis evidence' using errcode = '42501';
  end if;
  update public.ai_analysis_runs set slab_id = p_slab_id where id = p_run_id and slab_id is null;
  if not found then raise exception 'analysis run unavailable or already linked' using errcode = 'P0002'; end if;
  update public.ai_field_evidence set slab_id = p_slab_id where analysis_run_id = p_run_id;
end;
$$;
revoke all on function public.link_ai_analysis_run(uuid, uuid) from public, anon;
grant execute on function public.link_ai_analysis_run(uuid, uuid) to authenticated;
