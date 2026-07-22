-- ============================================================================
-- PR C.7.5.1: honest image-evidence semantics on the listing intent.
--
-- The prior `provider_verified_at` column implied cryptographic provider-side
-- image verification, which the current eBay Inventory API cannot support (it
-- returns OPAQUE image URLs, not content hashes). These columns replace that
-- misleading meaning with an accurate record of what we can actually attest:
--
--   * images_submitted_at        — when we SUBMITTED these images to the provider
--                                  for this offer (not a proof the provider still
--                                  holds the same bytes).
--   * image_verification_method  — how far verification could go:
--                                  submitted_only | provider_reference_match |
--                                  provider_content_hash_match | manual_review |
--                                  unverifiable. Only provider_reference_match or
--                                  provider_content_hash_match (with stable
--                                  provider evidence) may back an automated match.
--   * provider_image_evidence    — structured, NON-SENSITIVE evidence record
--                                  (method + provider offer/listing reference).
--                                  NEVER signed URLs, tokens, ciphertext, or PII.
--
-- provider_verified_at is DEPRECATED (no longer written or read) and left in
-- place additively — production holds ZERO listing intents, so no backfill.
-- ============================================================================

alter table public.ebay_listing_intents
  add column if not exists images_submitted_at timestamptz,
  add column if not exists image_verification_method text,
  add column if not exists provider_image_evidence jsonb;

comment on column public.ebay_listing_intents.provider_verified_at is
  'DEPRECATED (PR C.7.5.1): superseded by images_submitted_at + image_verification_method. No longer written or read; retained additively.';
comment on column public.ebay_listing_intents.images_submitted_at is
  'When our images were submitted to the provider for this offer. NOT proof the provider currently holds the same bytes.';
comment on column public.ebay_listing_intents.image_verification_method is
  'submitted_only | provider_reference_match | provider_content_hash_match | manual_review | unverifiable.';
comment on column public.ebay_listing_intents.provider_image_evidence is
  'Structured non-sensitive image-evidence (method + provider offer/listing reference). No signed URLs, tokens, or PII.';
