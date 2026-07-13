-- GradedCardValue.com — live raw-card scanner inventory, review queue, and
-- private scan evidence. Camera captures arrive through the authenticated
-- scan-card Edge Function; browsers never receive write access to these tables.

create table public.card_scans (
  id                 uuid primary key default gen_random_uuid(),
  created_by         uuid not null references auth.users(id) on delete restrict,
  image_storage_path text not null unique,
  image_sha256       text not null check (image_sha256 ~ '^[0-9a-f]{64}$'),
  mime_type          text not null check (mime_type = 'image/jpeg'),
  byte_size          integer not null check (byte_size > 0 and byte_size <= 10485760),
  card_name          text,
  set_name           text,
  card_number        text,
  rarity             text,
  condition_issues   jsonb not null default '{}'::jsonb,
  confidence         numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  status             text not null default 'processing' check (
    status in ('processing','added','needs_review','possible_duplicate','skipped','failed')
  ),
  model              text,
  schema_version     text not null default 'card-scan-1.0',
  openai_request_id  text,
  openai_usage       jsonb,
  latency_ms         integer check (latency_ms is null or latency_ms >= 0),
  error_code         text,
  raw_result         jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table public.cards (
  id                   uuid primary key default gen_random_uuid(),
  created_by           uuid not null references auth.users(id) on delete restrict,
  source_scan_id       uuid not null unique references public.card_scans(id) on delete restrict,
  card_name            text not null check (nullif(btrim(card_name), '') is not null),
  set_name             text not null check (nullif(btrim(set_name), '') is not null),
  card_number          text not null check (nullif(btrim(card_number), '') is not null),
  rarity               text,
  condition_notes      text,
  condition_issues     jsonb not null default '{}'::jsonb,
  identification_confidence numeric not null check (identification_confidence >= 0 and identification_confidence <= 1),
  scan_image_path      text not null,
  inventory_status     text not null default 'active' check (inventory_status in ('active','listed','sold','archived')),
  card_name_normalized text generated always as (lower(regexp_replace(btrim(card_name), '\\s+', ' ', 'g'))) stored,
  set_name_normalized  text generated always as (lower(regexp_replace(btrim(set_name), '\\s+', ' ', 'g'))) stored,
  card_number_normalized text generated always as (lower(regexp_replace(btrim(card_number), '[^a-zA-Z0-9/]+', '', 'g'))) stored,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index cards_identity_idx on public.cards
  (card_name_normalized, set_name_normalized, card_number_normalized);
create index cards_created_by_idx on public.cards (created_by, created_at desc);
create index card_scans_created_by_idx on public.card_scans (created_by, created_at desc);

create table public.card_scan_reviews (
  id             uuid primary key default gen_random_uuid(),
  scan_id        uuid not null unique references public.card_scans(id) on delete cascade,
  created_by     uuid not null references auth.users(id) on delete restrict,
  review_reason  text not null check (review_reason in ('low_confidence','possible_duplicate')),
  proposed_data  jsonb not null,
  status         text not null default 'pending' check (status in ('pending','confirmed','skipped')),
  corrected_data jsonb,
  resolved_by    uuid references auth.users(id) on delete set null,
  resolved_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index card_scan_reviews_pending_idx on public.card_scan_reviews (created_by, created_at desc)
  where status = 'pending';

alter table public.card_scans enable row level security;
alter table public.cards enable row level security;
alter table public.card_scan_reviews enable row level security;

revoke all on public.card_scans, public.cards, public.card_scan_reviews from public, anon;
grant select on public.card_scans, public.cards, public.card_scan_reviews to authenticated;
grant all on public.card_scans, public.cards, public.card_scan_reviews to service_role;

create policy card_scans_owner_admin_read on public.card_scans
  for select to authenticated
  using (created_by = (select auth.uid()) and public.is_admin((select auth.uid())));
create policy cards_owner_admin_read on public.cards
  for select to authenticated
  using (created_by = (select auth.uid()) and public.is_admin((select auth.uid())));
create policy card_scan_reviews_owner_admin_read on public.card_scan_reviews
  for select to authenticated
  using (created_by = (select auth.uid()) and public.is_admin((select auth.uid())));

-- Raw captures stay private. The Edge Function uses service role to upload and
-- returns short-lived signed URLs only to the authenticated owner/admin.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('card-scans', 'card-scans', false, 10485760, array['image/jpeg'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "card-scans owner admin read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'card-scans'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.is_admin((select auth.uid()))
  );

comment on table public.card_scans is 'Immutable-ish audit evidence for in-browser camera captures; images remain private.';
comment on table public.card_scan_reviews is 'Pending low-confidence or duplicate scanner decisions requiring explicit operator action.';
comment on table public.cards is 'Raw trading-card inventory accepted from the live scanner; graded slabs remain in public.slabs.';
