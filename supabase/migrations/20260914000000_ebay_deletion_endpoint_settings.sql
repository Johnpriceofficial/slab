-- 20260914000000_ebay_deletion_endpoint_settings.sql
-- Canonicalized from frontend backend-patch 20260730-ebay-deletion-token.
-- Durable, encrypted storage for the eBay Marketplace Account Deletion
-- verification token (eBay compliance): staff enter/rotate it in-app without a
-- redeploy. Ciphertext only (AES-256-GCM via the server-held key); the DB never
-- holds a usable token. Service-role only, RLS deny-all — unreachable via the
-- Data API. Additive, idempotent, non-destructive. eBay mutations stay disabled.
--
-- Reconciliation note: eBay *OAuth token* storage is NOT canonicalized here — the
-- canonical store is private.ebay_oauth_credentials / private.ebay_oauth_states
-- (service-role only, accessed via SECURITY DEFINER RPCs; migrations
-- 20260729/20260730/20260813-15). The out-of-band public.ebay_oauth_tokens /
-- public.ebay_oauth_states (frontend patch) are a less-secure duplicate and are
-- deliberately left un-canonicalized; see 10-ebay-reconciliation.md.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ebay_deletion_endpoint_settings (
  id text PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
  token_ciphertext text NOT NULL,
  token_length integer NOT NULL CHECK (token_length BETWEEN 32 AND 80),
  token_fingerprint text NOT NULL,
  endpoint_url text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

COMMENT ON TABLE public.ebay_deletion_endpoint_settings IS
  'Encrypted eBay marketplace account-deletion verification token. Service role only; never exposed to browsers.';
COMMENT ON COLUMN public.ebay_deletion_endpoint_settings.token_fingerprint IS
  'First 8 hex characters of sha256(token). Lets staff confirm the stored value matches the eBay portal without revealing it.';

GRANT ALL ON public.ebay_deletion_endpoint_settings TO service_role;

ALTER TABLE public.ebay_deletion_endpoint_settings ENABLE ROW LEVEL SECURITY;

COMMIT;
