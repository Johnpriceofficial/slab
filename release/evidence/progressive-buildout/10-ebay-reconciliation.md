# 10 — eBay backend reconciliation (item 5)

## Canonicalized: `ebay_deletion_endpoint_settings` (`20260914000000`)
The eBay Marketplace Account-Deletion verification-token store (eBay compliance).
Encrypted ciphertext only, **service-role only, RLS deny-all** (unreachable via the
Data API). Wired by the frontend server `src/integrations/ebay/deletion-token-store.server.ts`.
Absent from slab canonical + prod. Ported verbatim from `backend-patches/20260730-ebay-deletion-token`.

| Env | Applied | Verified |
| --- | --- | --- |
| disposable PG | ✅ | table + RLS on + service_role insert + anon denied |
| staging `msbdwwgojuvgnuugrrry` | ✅ | present |
| production `rcbwemkfcefarqnlgrmv` | ✅ | present, RLS on, `anon select=false`, `service insert=true` |

## NOT canonicalized (reconcile-by-supersession): eBay OAuth token storage
`backend-patches/20260730-ebay-oauth-token-storage` creates **`public.ebay_oauth_tokens`
/ `public.ebay_oauth_states`** (admin-RLS in the public schema). Slab **already** has
the canonical eBay OAuth store: **`private.ebay_oauth_credentials` / `private.ebay_oauth_states`**
(service-role only, accessed via SECURITY DEFINER RPCs — migrations `20260729`,
`20260730_private_schema_hardening`, `20260813`–`20260815`).

Decision: **do not canonicalize the public duplicate.** Reasons:
- It violates the standing rule *"do not duplicate existing objects"* / *"do not create
  duplicate backend implementations in the frontend repository."*
- `private.*` (service-role only) is strictly more secure than public admin-RLS.
- The out-of-band `public.ebay_oauth_tokens` in prod is **empty (0 rows)** → currently
  unused; the `authorized_at` patch (`20260730-ebay-authorized-at`) targets that same
  table and is therefore also not canonicalized.

**Follow-up (frontend, flagged — not done here):** the frontend eBay OAuth code
(`src/integrations/ebay/*`, 4 files referencing `public.ebay_oauth_tokens`) should be
rewired to slab's canonical eBay backend (edge functions / `private.ebay_oauth_credentials`
RPCs). Until then, the empty out-of-band public tables are left in place (dropping them
before the rewire would break the frontend's eBay-connect path); **do not** drop them yet.

## Safety
Additive only; no data migrated; eBay production mutations remain **disabled**;
service-role-only surface (no browser/anon exposure). Production ledger 80→81.
