-- §2 Auditable persistence. Forward-only. Three concerns:
--   1. A structured free-text rejection NOTE alongside the structured reason.
--   2. CHECK constraints on every enum-like confirmation column (integrity).
--   3. A single transactional RPC that writes the slab confirmation state AND the
--      append-only audit event together — all-or-nothing, so state and history can
--      never diverge (no half-written confirmation with no audit row, or vice versa).

-- 1. Free-text note to accompany the structured rejection reason. -----------------
alter table public.slabs
  add column if not exists visual_rejection_note text;

comment on column public.slabs.visual_rejection_note is
  'Optional free-text operator note accompanying the structured visual_rejection_reason.';

-- 2. CHECK constraints for the enum-like columns. -------------------------------
-- Each permits NULL (unset) plus the documented tokens. The columns were added in
-- 20260724 and only ever written by our own code with conforming values, so these
-- validate cleanly.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'slabs_visual_confirmation_status_chk') then
    alter table public.slabs add constraint slabs_visual_confirmation_status_chk check (
      visual_confirmation_status is null or visual_confirmation_status in
        ('not_available', 'not_reviewed', 'user_confirmed', 'user_rejected', 'metadata_auto_confirmed')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_candidate_image_source_chk') then
    alter table public.slabs add constraint slabs_candidate_image_source_chk check (
      candidate_image_source is null or candidate_image_source in ('official_product', 'marketplace_offer', 'none')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_candidate_image_type_chk') then
    alter table public.slabs add constraint slabs_candidate_image_type_chk check (
      candidate_image_type is null or candidate_image_type in ('marketplace_offer_image', 'official_product_image')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_visual_confirmation_method_chk') then
    alter table public.slabs add constraint slabs_visual_confirmation_method_chk check (
      visual_confirmation_method is null or visual_confirmation_method in ('side_by_side')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_product_confirmation_source_chk') then
    alter table public.slabs add constraint slabs_product_confirmation_source_chk check (
      product_confirmation_source is null or product_confirmation_source in
        ('search_auto', 'search_manual', 'manual_product_id', 'manual_product_url')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slabs_visual_rejection_reason_chk') then
    alter table public.slabs add constraint slabs_visual_rejection_reason_chk check (
      visual_rejection_reason is null or visual_rejection_reason in
        ('wrong_card', 'wrong_character', 'wrong_number', 'wrong_set', 'wrong_year',
         'wrong_language', 'wrong_variation', 'image_mismatch', 'other')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'slab_pc_events_type_chk') then
    alter table public.slab_pricecharting_events add constraint slab_pc_events_type_chk check (
      event_type in ('product_confirmed', 'product_invalidated', 'product_unavailable',
                     'visual_confirmed', 'visual_rejected', 'image_refreshed')
    );
  end if;
end $$;

-- 3. Transactional confirmation writer. -----------------------------------------
-- SECURITY DEFINER so the append-only event insert (admin-gated by RLS) and the
-- slab update run under one authorization check and ONE transaction. If either
-- statement fails the whole call rolls back: state and audit stay consistent.
-- The derivation of WHICH fields to write (a rejected product is never stamped
-- confirmed) lives in the caller's tested buildConfirmationPatch; this function is
-- the mechanical, atomic writer. The actor is taken from auth.uid(), never trusted
-- from the client payload.
create or replace function public.record_pricecharting_confirmation(
  p_slab_id uuid,
  p_patch   jsonb,
  p_event   jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_is_user boolean := (p_patch ? 'visual_confirmation_at') and (p_patch->>'visual_confirmation_at') is not null;
begin
  if not public.is_admin(v_actor) then
    raise exception 'not authorized to record a PriceCharting confirmation' using errcode = '42501';
  end if;

  update public.slabs set
    candidate_image_url          = p_patch->>'candidate_image_url',
    candidate_image_source       = p_patch->>'candidate_image_source',
    candidate_image_type         = p_patch->>'candidate_image_type',
    candidate_image_retrieved_at = (p_patch->>'candidate_image_retrieved_at')::timestamptz,
    candidate_image_available    = (p_patch->>'candidate_image_available')::boolean,
    visual_confirmation_status   = p_patch->>'visual_confirmation_status',
    visual_confirmation_method   = p_patch->>'visual_confirmation_method',
    visual_confirmation_at       = (p_patch->>'visual_confirmation_at')::timestamptz,
    -- Actor is server-derived, never taken from the client payload.
    visual_confirmation_by       = case when v_is_user then v_actor else null end,
    visual_rejection_reason      = p_patch->>'visual_rejection_reason',
    visual_rejection_note        = p_patch->>'visual_rejection_note',
    product_confirmation_source  = p_patch->>'product_confirmation_source',
    product_confirmed_at         = (p_patch->>'product_confirmed_at')::timestamptz,
    scoring_version              = (p_patch->>'scoring_version')::integer
  where id = p_slab_id;

  if not found then
    raise exception 'slab % not found', p_slab_id using errcode = 'P0002';
  end if;

  insert into public.slab_pricecharting_events (slab_id, event_type, product_id, source, detail, created_by)
  values (
    p_slab_id,
    p_event->>'event_type',
    p_event->>'product_id',
    p_event->>'source',
    coalesce(p_event->'detail', '{}'::jsonb),
    v_actor
  );
end;
$$;

grant execute on function public.record_pricecharting_confirmation(uuid, jsonb, jsonb) to authenticated;
