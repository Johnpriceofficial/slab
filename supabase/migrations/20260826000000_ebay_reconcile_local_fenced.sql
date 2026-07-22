-- ============================================================================
-- PR C.8 P0 preflight: fence local reconciliation against a concurrent publish,
-- and stop fabricating image-submission provenance.
--
-- The C.7.5.1 RPC proved identity + fingerprint under a row lock, but (1) it did
-- NOT verify the intent's expected CURRENT status/offer_id/listing_id/updated_at,
-- so a reconcile that read a stale row could overwrite a newer provider identity
-- written by a racing publish; and (2) it set `images_submitted_at = now()` when
-- absent, manufacturing historical submission provenance.
--
-- This replaces the RPC (new 15-arg signature): it adds an OPTIMISTIC-CONCURRENCY
-- fence (verified only when p_expected_updated_at is supplied — the publish path
-- holds the single-flight lease and passes null), and it NEVER writes
-- images_submitted_at (null stays null); the verification method is advanced to
-- `provider_reference_match` ONLY when prior submission provenance already exists.
--
-- Forward-only; the old 11-arg signature is dropped. service_role only.
-- ============================================================================

drop function if exists public.ebay_listing_reconcile_local(uuid, uuid, text, uuid, text, text, text, bigint, text, text, integer);

create or replace function public.ebay_listing_reconcile_local(
  p_account_id uuid,
  p_slab_id uuid,
  p_sku text,
  p_intent_id uuid,
  p_offer_id text,
  p_listing_id text,
  p_listing_status text,
  p_asking_price_cents bigint,
  p_currency text,
  p_expected_fingerprint text,
  p_expected_fingerprint_version integer,
  p_expected_status text,
  p_expected_offer_id text,
  p_expected_listing_id text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_intent public.ebay_listing_intents;
  v_rows integer;
begin
  if coalesce(p_offer_id, '') = '' then
    return jsonb_build_object('ok', false, 'error_code', 'missing_offer_id');
  end if;

  select * into v_intent from public.ebay_listing_intents where id = p_intent_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'intent_not_found');
  end if;
  if v_intent.ebay_account_id <> p_account_id
     or v_intent.sku <> p_sku
     or v_intent.slab_id is distinct from p_slab_id then
    return jsonb_build_object('ok', false, 'error_code', 'intent_identity_mismatch');
  end if;
  if v_intent.fingerprint is distinct from p_expected_fingerprint
     or v_intent.fingerprint_version is distinct from p_expected_fingerprint_version then
    return jsonb_build_object('ok', false, 'error_code', 'fingerprint_mismatch');
  end if;

  -- OPTIMISTIC-CONCURRENCY FENCE (reconcile passes a version; publish passes null).
  -- A racing publish that changed the row after the caller read it makes this
  -- reconcile stale → reject WITHOUT writing the intent or the mapping.
  if p_expected_updated_at is not null then
    if v_intent.updated_at is distinct from p_expected_updated_at
       or v_intent.status is distinct from p_expected_status
       or v_intent.offer_id is distinct from nullif(p_expected_offer_id, '')
       or v_intent.listing_id is distinct from nullif(p_expected_listing_id, '') then
      return jsonb_build_object('ok', false, 'error_code', 'stale_intent');
    end if;
  end if;

  -- Intent FIRST (so a later mapping failure rolls this back). NEVER fabricate
  -- images_submitted_at; advance the method only when submission provenance exists.
  update public.ebay_listing_intents
     set status = 'published',
         offer_id = p_offer_id,
         listing_id = nullif(p_listing_id, ''),
         image_verification_method = case when images_submitted_at is not null then 'provider_reference_match' else image_verification_method end,
         provider_image_evidence = case when images_submitted_at is not null
           then jsonb_build_object('method', 'provider_reference_match', 'offer_id', p_offer_id, 'listing_id', nullif(p_listing_id, ''))
           else provider_image_evidence end,
         last_error = null,
         updated_at = now()
   where id = p_intent_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'ebay_listing_reconcile_local: intent update affected % rows', v_rows;
  end if;

  insert into public.ebay_listing_mappings
    (slab_id, ebay_account_id, sku, offer_id, listing_id, listing_status, asking_price_cents, currency, last_synced_at)
  values
    (p_slab_id, p_account_id, p_sku, p_offer_id, nullif(p_listing_id, ''), coalesce(p_listing_status, 'published'), p_asking_price_cents, coalesce(p_currency, 'USD'), now())
  on conflict (ebay_account_id, sku) do update
    set offer_id = excluded.offer_id,
        listing_id = excluded.listing_id,
        listing_status = excluded.listing_status,
        asking_price_cents = excluded.asking_price_cents,
        currency = excluded.currency,
        last_synced_at = now();
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'ebay_listing_reconcile_local: mapping upsert affected % rows', v_rows;
  end if;

  return jsonb_build_object('ok', true, 'offer_id', p_offer_id, 'listing_id', nullif(p_listing_id, ''));
end;
$$;

revoke all on function public.ebay_listing_reconcile_local(uuid, uuid, text, uuid, text, text, text, bigint, text, text, integer, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.ebay_listing_reconcile_local(uuid, uuid, text, uuid, text, text, text, bigint, text, text, integer, text, text, text, timestamptz) to service_role;

comment on function public.ebay_listing_reconcile_local(uuid, uuid, text, uuid, text, text, text, bigint, text, text, integer, text, text, text, timestamptz) is
  'Atomic, fingerprint- and version-fenced local listing reconciliation. service_role only. No provider mutation; never fabricates images_submitted_at.';
