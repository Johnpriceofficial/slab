-- ============================================================================
-- GradedCardValue.com — front/back intake for raw cards.
--
-- Two additions that let the universal scanner store a back image on a raw card
-- AND create the card from the FRONT analysis it already ran — with no second
-- model call:
--   1. cards.back_image_path — the optional back photo on a raw-card record.
--   2. stage_raw_card() — creates the card_scans + cards rows from a client's
--      captured images + the extraction the universal analysis produced. No AI.
--   3. a card-scans storage INSERT policy so an owner can upload their own
--      capture (front + optional back), mirroring how slab images are uploaded
--      client-side. Reads stay owner-scoped; the R-code comes from the existing
--      raw-card trigger.
--
-- Graded slabs keep their existing dual-image flow (slab-images bucket); this is
-- only the RAW side of the front/back workflow.
-- ============================================================================

alter table public.cards
  add column if not exists back_image_path text;

-- ── Owner may upload their own card-scan images (front + back) ───────────────
-- Path convention is "{owner}/{uuid}.jpg"; the first folder segment must be the
-- caller. Service-role scanner inserts are unaffected (they bypass RLS).
drop policy if exists "card-scans owner insert" on storage.objects;
create policy "card-scans owner insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'card-scans'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- ── stage_raw_card: create a raw card from the universal analysis, no model ──
-- The caller uploads the image(s) to the card-scans bucket, then hands the
-- storage paths + extraction here. The front image's path must sit under the
-- caller's own folder (defense in depth on top of the storage policy). Required
-- identity fields are enforced by the cards table's own NOT NULL / non-blank
-- constraints; a gap surfaces as an error the scanner resolves with a back
-- capture or a reanalysis before retrying.
create or replace function public.stage_raw_card(p jsonb)
returns public.cards
language plpgsql
security definer
set search_path = public, auth, storage
as $$
declare
  v_uid uuid := (select auth.uid());
  v_front text := nullif(btrim(p->>'front_image_path'), '');
  v_back text := nullif(btrim(p->>'back_image_path'), '');
  v_sha text := p->>'front_sha256';
  v_size integer := (p->>'front_byte_size')::integer;
  v_conf numeric := coalesce((p->>'confidence')::numeric, 0);
  v_scan_id uuid;
  v_row public.cards;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  -- Suspended/closed accounts cannot create inventory (mirrors create_slab).
  if not public.is_admin(v_uid) then
    if (select account_status from public.customer_profiles where id = v_uid) is distinct from 'active' then
      raise exception 'NOT_AUTHORIZED' using errcode = '42501';
    end if;
  end if;
  if v_front is null then
    raise exception 'FRONT_IMAGE_REQUIRED' using errcode = '22023';
  end if;
  if (storage.foldername(v_front))[1] is distinct from v_uid::text then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if v_back is not null and (storage.foldername(v_back))[1] is distinct from v_uid::text then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  insert into public.card_scans (created_by, image_storage_path, image_sha256, mime_type, byte_size, confidence, status)
  values (v_uid, v_front, v_sha, 'image/jpeg', v_size, v_conf, 'added')
  returning id into v_scan_id;

  insert into public.cards (
    created_by, source_scan_id, card_name, set_name, card_number, rarity,
    condition_notes, condition_issues, identification_confidence,
    scan_image_path, back_image_path
  ) values (
    v_uid, v_scan_id,
    nullif(btrim(p->>'card_name'), ''),
    nullif(btrim(p->>'set_name'), ''),
    nullif(btrim(p->>'card_number'), ''),
    nullif(btrim(p->>'rarity'), ''),
    nullif(btrim(p->>'condition_notes'), ''),
    coalesce(p->'condition_issues', '{}'::jsonb),
    v_conf,
    v_front, v_back
  ) returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.stage_raw_card(jsonb) from public, anon;
grant execute on function public.stage_raw_card(jsonb) to authenticated;

comment on column public.cards.back_image_path is 'Optional back photo captured during front/back intake.';
comment on function public.stage_raw_card(jsonb) is 'Create a raw card from the universal analysis + uploaded images, with no second model call.';
