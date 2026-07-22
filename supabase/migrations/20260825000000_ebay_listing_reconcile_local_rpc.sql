-- ============================================================================
-- PR C.7.5.1: ATOMIC local listing reconciliation.
--
-- Local reconciliation previously wrote the mapping and the intent SEPARATELY, so
-- one could succeed while the other failed (a durable split-brain). This
-- SECURITY DEFINER RPC does both in ONE transaction after proving identity +
-- fingerprint, so the mapping and intent are always consistent or neither
-- changes. NO provider mutation; NO credential/PII exposure. service_role only.
--
-- Ordering: the intent is updated FIRST, the mapping upserted SECOND — any failure
-- (including the mapping's asking_price_cents >= 0 CHECK) RAISES and rolls BOTH
-- back. Identity + fingerprint are validated under a row lock BEFORE any write, so
-- a stale/forged/foreign request rejects structurally with ZERO writes.
-- ============================================================================

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
  p_expected_fingerprint_version integer
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

  -- Lock the intent row and prove identity + fingerprint BEFORE any write.
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

  -- Intent FIRST (so a later mapping failure rolls this back).
  update public.ebay_listing_intents
     set status = 'published',
         offer_id = p_offer_id,
         listing_id = nullif(p_listing_id, ''),
         images_submitted_at = coalesce(images_submitted_at, now()),
         image_verification_method = 'provider_reference_match',
         provider_image_evidence = jsonb_build_object(
           'method', 'provider_reference_match',
           'offer_id', p_offer_id,
           'listing_id', nullif(p_listing_id, '')
         ),
         last_error = null,
         updated_at = now()
   where id = p_intent_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'ebay_listing_reconcile_local: intent update affected % rows', v_rows;
  end if;

  -- Mapping SECOND (exactly one row). The asking_price_cents >= 0 CHECK, the
  -- (account, sku) / (account, offer_id) UNIQUE constraints, and the slab FK all
  -- raise on violation → the whole transaction (incl. the intent update) rolls back.
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

revoke all on function public.ebay_listing_reconcile_local(uuid, uuid, text, uuid, text, text, text, bigint, text, text, integer) from public, anon, authenticated;
grant execute on function public.ebay_listing_reconcile_local(uuid, uuid, text, uuid, text, text, text, bigint, text, text, integer) to service_role;

comment on function public.ebay_listing_reconcile_local(uuid, uuid, text, uuid, text, text, text, bigint, text, text, integer) is
  'Atomic local listing reconciliation: proves identity + fingerprint under a row lock, then updates the intent and upserts the mapping in one transaction. service_role only. No provider mutation.';
