-- Security hardening (Phase 2). All changes are DEFENSIVE and idempotent:
--   1. Pin a fixed search_path on EVERY SECURITY DEFINER function that lacks one
--      (fixes mutable-search_path warnings) WITHOUT touching function bodies.
--   2. Make the deny-all posture of service-only tables explicit: RLS enabled +
--      NO client privileges for anon/authenticated (service_role only).
--   3. Add covering indexes for active foreign keys (guarded — only where the
--      column exists), so lookups don't seq-scan as data grows.
-- Nothing here weakens RLS or ownership. No function logic changes.

-- Per-function EXECUTE-grant audit (no grant changes here — grants are already
-- explicitly classified in earlier migrations and verified correct):
--   Customer RPCs (authenticated):  create_slab, stage_raw_card, apply_slab_pricing,
--     archive_slab, unarchive_slab, check_slab_certification,
--     record_pricecharting_confirmation, resolve_inventory, resolve_slab_inventory,
--     link_ai_analysis_run — each proves auth.uid()/ownership or admin INSIDE the body.
--   Admin-only (authenticated + internal is_admin gate): hard_delete_slab and admin
--     maintenance RPCs — the body returns NOT_AUTHORIZED for non-admins.
--   RLS helpers (MUST keep authenticated[,anon] EXECUTE — is_admin is referenced by
--     40 RLS policies): is_admin, can_access_slab, normalize_cert, normalize_grader.
--   Trigger functions (fire via triggers, no client EXECUTE needed): assign_raw_card_
--     inventory, enforce_inventory_id_immutable, next_slab_inventory_number,
--     set_child_owner_from_slab, set_derivative_owner_from_image, capture_*, etc.
-- This migration deliberately does NOT rewrite those grants: a blind revoke would
-- break the 40 is_admin RLS policies. Grant changes, if the Supabase Advisor flags
-- specific PUBLIC grants, must be added per-function after reviewing that finding.

-- ── 1. Fixed search_path on all SECURITY DEFINER functions ──────────────────
-- A SECURITY DEFINER function with a mutable search_path is a privilege-
-- escalation risk (a caller could shadow an unqualified object). We pin it to
-- the function's own schema chain. This changes ONLY the search_path config —
-- never the body, signature, or EXECUTE grants. Introspection is used so exact
-- overloaded signatures are always correct. Functions that already fix
-- search_path are skipped (idempotent). This fixes the Advisor
-- `function_search_path_mutable` warnings for enforce_inventory_id_immutable,
-- parse_inventory_code, assign_raw_card_inventory, and every other definer fn.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch, p.proname AS fn, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef
      AND n.nspname IN ('public', 'private')
      AND NOT EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c
        WHERE split_part(c, '=', 1) = 'search_path'
      )
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = %s',
      r.sch, r.fn, r.args,
      CASE WHEN r.sch = 'private' THEN 'private, public, pg_temp' ELSE 'public, pg_temp' END
    );
  END LOOP;
END $$;

-- ── 2. Service-only tables: explicit deny-all for clients ───────────────────
-- These tables hold rate-limit counters and encrypted eBay/private data. They
-- are RLS-enabled with NO policies (which already denies all client access);
-- here we ALSO revoke every table privilege from anon/authenticated so the
-- deny-all is explicit and belt-and-suspenders, and document the intent.
-- Access is service_role only (Edge Functions with the service key), which
-- BYPASSES RLS — so we do NOT FORCE RLS (that only affects the table owner and
-- could interfere with owner-run maintenance; the revoke + no-policy already
-- denies every client). Service-role workflows are proven still-working by the
-- integration suite.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'public.api_rate_limits', 'public.api_daily_usage', 'public.api_user_daily_usage',
    'private.ebay_oauth_credentials', 'private.ebay_oauth_states', 'private.ebay_orders',
    'private.ebay_order_line_items', 'private.ebay_fulfillments', 'private.ebay_financial_transactions'
  ]
  LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('REVOKE ALL ON %s FROM anon, authenticated', t);
      EXECUTE format(
        'COMMENT ON TABLE %s IS %L', t,
        'Service-only. RLS enabled with NO client policies = deny-all for anon/authenticated by design; access via service_role only.'
      );
    END IF;
  END LOOP;
END $$;

-- ── 3. Covering indexes for active foreign keys (guarded) ───────────────────
-- Created only where the column exists (skips any name that does not resolve,
-- so the migration is safe across schema drift). Never dropped — small tables
-- today, but these are the hot lookup paths at launch scale.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public', 'ai_analysis_runs',        'slab_id'),
    ('public', 'ai_field_evidence',       'analysis_run_id'),
    ('public', 'ai_field_evidence',       'slab_id'),
    ('public', 'ai_field_evidence',       'image_id'),
    ('public', 'ai_field_evidence',       'derivative_id'),
    ('public', 'slab_images',             'slab_id'),
    ('public', 'valuation_snapshots',     'pricecharting_product_id'),
    ('public', 'sold_comps',              'slab_id'),
    ('public', 'slab_comps',              'slab_id'),
    ('public', 'marketplace_events',      'slab_id'),
    ('public', 'ebay_listing_mappings',   'slab_id'),
    ('public', 'slab_product_candidates', 'pricecharting_product_id'),
    ('public', 'slab_product_links',      'pricecharting_product_id')
  ) AS t(sch, tbl, col)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = r.sch AND table_name = r.tbl AND column_name = r.col
    ) THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON %I.%I (%I)',
        'idx_' || r.tbl || '_' || r.col, r.sch, r.tbl, r.col
      );
    END IF;
  END LOOP;
END $$;
