-- ============================================================================
-- PR C.7.5: durable, VERSIONED intended-listing state on the listing intent.
--
-- The intent already records status/offer_id/listing_id/fingerprint. This adds
-- the DURABLE snapshot of the exact prepared listing so a retry or reconcile can
-- verify provider state against the exact intended inputs — never against a
-- request body or a signed URL.
--
--  * intended_state       — canonical, sanitized listing inputs (see IntendedStateV1).
--                           Contains ONLY listing parameters (SKU, marketplace,
--                           format, category, location, policies, price, currency,
--                           quantity, descriptions, title, condition, descriptors,
--                           aspects). NEVER signed URLs, tokens, auth headers,
--                           OAuth codes/states, encrypted credentials, raw provider
--                           responses/requests, buyer PII, or financial payloads.
--  * fingerprint_version  — the fingerprint algorithm version (v3 = SHA-256).
--  * image_manifest       — stable LOCAL image evidence only: role, storage path,
--                           SHA-256 hash, count, deterministic order (ImageManifestV1).
--  * provider_verified_at — set when a publish/create records the exact offer +
--                           listing identity for this intent; the persisted proof
--                           that the manifest images are the images used for that
--                           provider item (drives "verified" image evidence).
--
-- All columns are nullable and additive; production holds ZERO listing intents,
-- so no backfill is required and no existing row is rewritten.
-- ============================================================================

alter table public.ebay_listing_intents
  add column if not exists intended_state jsonb,
  add column if not exists fingerprint_version integer,
  add column if not exists image_manifest jsonb,
  add column if not exists provider_verified_at timestamptz;

comment on column public.ebay_listing_intents.intended_state is
  'Canonical sanitized listing inputs (IntendedStateV1). No secrets, signed URLs, raw provider payloads, or PII.';
comment on column public.ebay_listing_intents.fingerprint_version is
  'Fingerprint algorithm version (3 = SHA-256 over intended_state + image_manifest).';
comment on column public.ebay_listing_intents.image_manifest is
  'Stable local image evidence only (role, storage path, SHA-256 hash, count, order). No signed URLs.';
comment on column public.ebay_listing_intents.provider_verified_at is
  'Set when the exact provider offer/listing identity was recorded for this intent; proof the manifest images back that provider item.';
