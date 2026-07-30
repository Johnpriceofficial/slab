# Rollback — Graded Card Value backend customer-analysis launch

## Instant customer kill switch (no redeploy)
`supabase secrets set ANALYZE_SLAB_CUSTOMER_ENABLED=false --project-ref rcbwemkfcefarqnlgrmv`
Non-admin analyze-slab callers immediately get 403 CUSTOMER_ACCESS_DISABLED (fail-closed). Admin unaffected.

## Revert the Edge Function to the previous version
Production analyze-slab was v86 (admin-only, ezbr_sha256 b5d567f5…). To roll back:
redeploy the prior admin-only source, or in the Supabase dashboard (Functions → analyze-slab → Versions)
promote v86. New version is v87 (14c4d158…). Reverting the function does not touch the database.

## Database
- DO NOT delete or rewrite applied migrations. All writes go through SECURITY DEFINER RPCs; the slabs table
  is RLS-protected with authenticated=SELECT-only + guard/forbid-delete triggers. Reverting the function
  never requires a schema change.
- Migrations are forward-only. No migration was applied in this release; production schema was already
  correct for the launch (verified).

## Frontend
- Frontend product code is unchanged in this scope (PR #6 is test-harness/CI only). To disable a specific
  client action without re-enabling unsafe legacy paths, gate the action in the frontend; never restore the
  create-then-link save flow or direct slabs.update.

## Data preservation
- No production reset. No destructive tests against real records. Disposable verification accounts were
  created and deleted (0 remain).
