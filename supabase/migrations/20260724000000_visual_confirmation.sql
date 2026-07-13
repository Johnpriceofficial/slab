-- §4 Visual-confirmation storage. Purely additive: nullable columns on slabs for
-- the current image + confirmation state, plus an APPEND-ONLY audit table so a
-- refresh never silently rewrites confirmation history.

alter table public.slabs
  add column if not exists candidate_image_url          text,
  add column if not exists candidate_image_source       text,      -- e.g. 'marketplace_offer'
  add column if not exists candidate_image_type         text,      -- e.g. 'marketplace_offer_image'
  add column if not exists candidate_image_retrieved_at timestamptz,
  add column if not exists candidate_image_available     boolean,
  -- not_available | not_reviewed | user_confirmed | user_rejected | metadata_auto_confirmed
  add column if not exists visual_confirmation_status   text,
  add column if not exists visual_confirmation_method   text,      -- e.g. 'side_by_side'
  add column if not exists visual_confirmation_at        timestamptz,
  add column if not exists visual_confirmation_by        uuid references auth.users(id) on delete set null,
  add column if not exists visual_rejection_reason       text,
  -- search_auto | search_manual | manual_product_id | manual_product_url
  add column if not exists product_confirmation_source  text,
  add column if not exists product_confirmed_at          timestamptz,
  add column if not exists scoring_version               integer;

comment on column public.slabs.visual_confirmation_status is
  'not_available | not_reviewed | user_confirmed | user_rejected | metadata_auto_confirmed. user_confirmed is NEVER set for an automatic metadata match.';
comment on column public.slabs.candidate_image_source is
  'The image is a marketplace SELLER OFFER photo, not an authoritative PriceCharting catalog image.';

-- Append-only audit trail: every confirmation / rejection / invalidation / image
-- refresh is recorded, never overwritten. Historical confirmations are preserved.
create table if not exists public.slab_pricecharting_events (
  id          uuid primary key default gen_random_uuid(),
  slab_id     uuid not null references public.slabs(id) on delete cascade,
  event_type  text not null, -- product_confirmed|product_invalidated|product_unavailable|visual_confirmed|visual_rejected|image_refreshed
  product_id  text,
  source      text,
  detail      jsonb,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists slab_pc_events_slab_idx on public.slab_pricecharting_events (slab_id, created_at desc);

alter table public.slab_pricecharting_events enable row level security;
drop policy if exists "slab_pc_events admin all" on public.slab_pricecharting_events;
-- Admins may READ and APPEND; there is intentionally no UPDATE/DELETE path so the
-- audit trail is append-only and history is never rewritten.
create policy "slab_pc_events admin read" on public.slab_pricecharting_events
  for select to authenticated using (public.is_admin(auth.uid()));
create policy "slab_pc_events admin insert" on public.slab_pricecharting_events
  for insert to authenticated with check (public.is_admin(auth.uid()));

grant select, insert on public.slab_pricecharting_events to authenticated;
