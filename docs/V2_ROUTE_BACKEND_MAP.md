# V2 Route → Backend Map — Graded Card Value

> **Source commit:** `ba3953fdb68c31435c7dac732f67d8d53aa2adcb` · **Schema state:** 65 migrations (20260709000000..20260904000000) · **Contract version:** `1.0.0-ba3953fd-m65` · **Date:** 2026-07-27
>
> **Generated documentation of existing behavior — not a change proposal.** Maps all 36 intended V2 routes to the backend surface defined by `contracts/backend-operations.ts` (31 operations). Route presence was surveyed in the V2 frontend repo `slab-scribe-pro` (branch `chore/v2-contract-consumer`, HEAD `c4c55037`).

Companion docs: [V2_BACKEND_CONTRACTS.md](V2_BACKEND_CONTRACTS.md) (tables/RPCs/operations), [V2_EDGE_FUNCTION_CONTRACTS.md](V2_EDGE_FUNCTION_CONTRACTS.md), [V2_STORAGE_AUTH_MATRIX.md](V2_STORAGE_AUTH_MATRIX.md), [V2_SECURITY_BOUNDARIES.md](V2_SECURITY_BOUNDARIES.md).

---

## 1. Route presence in slab-scribe-pro (21 present / 15 missing)

- **Present (21):** all 9 public routes, `/dashboard`, `/scan`, `/scan/graded`, `/scan/raw`, `/analysis/:analysisId`, `/inventory`, `/inventory/slabs`, `/inventory/raw`, `/slabs/:slabId`, `/raw-cards/:rawCardId`, `/cards/:cardId`, `/admin`.
- **Missing (15):** `/pricing-evidence/:itemId`, `/activity`, `/account`, `/account/profile`, `/account/security`, `/account/subscription`, `/account/integrations`, `/admin/analysis`, `/admin/slabs`, `/admin/raw-cards`, `/admin/pricing`, `/admin/users`, `/admin/audit`, `/admin/ebay`, `/builder`.
- All 15 missing routes are already declared in `src/app/route-config.ts` and linked from `src/components/navigation/nav-items.ts`; clicking them today falls through to the root `notFoundComponent`. (One extra route exists: `/not-found`, an explicit 404 page — harmless.)
- All data access in slab-scribe-pro goes through the `BackendProvider` service layer and is currently **mock-backed** (no `@supabase/supabase-js` installed; `src/integrations/supabase/provider.ts` throws `backend_contract_required` on every method).

## 2. Legend

| Code | Meaning |
|---|---|
| **S0** | Static content — no async loading/empty/error states. |
| **S1** | Read page: skeleton → content; explicit empty state on zero rows; `BackendError` banner (auto-retry only for `RETRIABLE_CODES`: NETWORK_ERROR, BACKEND_UNAVAILABLE, EBAY_SYNC_BUSY, RATE_LIMITED). |
| **S2** | S1 + mutation flow: client Zod validation (`VALIDATION_FAILED` before network), submit-disabled while pending, toast/inline error on failure, `CONFLICT`/`STALE_WRITE` shown non-retriably. |
| **U0** | Public — no auth gate. |
| **U1** | Authenticated gate (`_authed` layout): anonymous → UnauthorizedState → `/sign-in`; expired session → SessionExpiredState. Backend enforcement: JWT required; RLS owner scoping; error `AUTH_REQUIRED`. |
| **U2** | U1 + admin gate (`_admin` layout, `can(ADMIN_PERMISSION)`): non-admin → UnauthorizedState. Backend enforcement: `is_admin()` app-metadata check in RPC bodies/RLS admin policies — non-admins get `FORBIDDEN` (42501) or RLS-empty result sets. Client gating is UX-only; authorization is server-side. |

"Reads/Writes" name tables; "RPCs"/"Edge fns" name backend functions; "Ops" reference the 31-operation manifest. "none (static)" = route needs no backend.

---

## 3. Public routes (9)

| Route | In repo | Role | Reads | Writes | RPCs | Edge fns | Storage | States | Unauthorized | Missing contracts | Classification |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `/` | yes | anon | none (static) | none | — | — | — | S0 | U0 | — | public static |
| `/how-it-works` | yes | anon | none (static) | none | — | — | — | S0 | U0 | — | public static |
| `/pricing` | yes | anon | none (static — no billing backend) | none | — | — | — | S0 | U0 | — | public static |
| `/demo` | yes | anon | none (mock fixtures `DEMO_SLABS`/`DEMO_ANALYSES` imported directly; by design) | none | — | — | — | S0 | U0 | — | public static (mock-only) |
| `/sign-in` | yes | anon | auth:gotrue (ops `signIn`, `getSession`) | session creation | — | — | — | S2 (errors: AUTH_INVALID_CREDENTIALS, AUTH_CAPTCHA_REQUIRED) | U0 | hCaptcha not implemented in V2 repo (V1 requires it when site key set) | BROWSER_CUSTOMER_SAFE |
| `/sign-up` | yes | anon | auth:gotrue signUp (+email verification redirect) | account creation | — | — | — | S2 | U0 | **No `signUp` operation in the 31-op manifest**; V1 flow (emailRedirectTo, captcha, 10+ char password) undocumented in contract | BROWSER_CUSTOMER_SAFE (gap) |
| `/forgot-password` | yes | anon | auth:gotrue resetPasswordForEmail | sends reset email | — | — | — | S2 | U0 | **No password-reset operation in the manifest** (V1 also has a `/reset-password` recovery page — absent from the 36-route list) | BROWSER_CUSTOMER_SAFE (gap) |
| `/terms` | yes | anon | none (static) | none | — | — | — | S0 | U0 | — | public static |
| `/privacy` | yes | anon | none (static) | none | — | — | — | S0 | U0 | — | public static |

---

## 4. Authenticated routes (18)

| Route | In repo | Role | Reads | Writes | RPCs | Edge fns | Storage | States | Unauthorized | Missing contracts | Classification |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `/dashboard` | yes | customer | slabs, cards, valuation_snapshots, customer_profiles (ops `getDashboardSummary`, `getCurrentProfile`) | none | — | — | slab-images signed thumbs (optional) | S1 | U1 | summary is client-aggregated (ADAPTER_REQUIRED); summary RPC is a future optimization, not a blocker | BROWSER_CUSTOMER_SAFE |
| `/scan` | yes | customer | customer_profiles (op `getCurrentProfile` — daily scan allowance) | none | — | — | — | S1 (hub) | U1 | — | BROWSER_CUSTOMER_SAFE |
| `/scan/graded` | yes | customer | slabs (dup-check feedback) | slabs (RPC), slab_images, storage upload (ops `createSlabIntake`, `uploadSlabImage`, `startSlabAnalysis`) | create_slab (+check_slab_certification pre-check, link_ai_analysis_run link step) | scan-card | slab-images write (server-assigned `slabs/<n>/…` paths) | S2 (DUPLICATE_CERTIFICATION→CONFLICT; ANALYSIS_QUOTA_EXCEEDED; UPLOAD_TOO_LARGE/UNSUPPORTED_TYPE) | U1 (+AUTH_ACCOUNT_SUSPENDED on write) | upload+register must be one adapter operation (V1 does separate `slab_images` insert; HEIC normalization in adapter) | BROWSER_CUSTOMER_SAFE |
| `/scan/raw` | yes | customer | cards | cards + card_scans (RPC), storage upload (ops `createRawCardIntake`, `startSlabAnalysis`) | stage_raw_card | scan-card (quota-gated, fails closed) | card-scans write (client-built `<uid>/<uuid>.jpg`) | S2 (ANALYSIS_QUOTA_EXCEEDED) | U1 (+AUTH_ACCOUNT_SUSPENDED) | — | BROWSER_CUSTOMER_SAFE |
| `/analysis/:analysisId` | yes | customer | ai_analysis_runs, ai_field_evidence (op `getAnalysis`) | slab confirmation patch + event (op `confirmAnalysis`); slab field corrections (op `correctAnalysis`) | record_pricecharting_confirmation | — | slab-images signed URLs | S1+S2; NOT_FOUND for foreign/absent run (RLS-filtered, indistinguishable by design) | U1 | **`correctAnalysis` = direct unwhitelisted `slabs` patch today — needs a whitelisted correction RPC** (SECURITY_REVIEW_REQUIRED / BACKEND_CONTRACT_REQUIRED) | BROWSER_CUSTOMER_SAFE except correctAnalysis |
| `/inventory` | yes | customer | slabs, cards (ops `listSlabs`, `listRawCards`) | none | resolve_inventory (S123/R123/bare-number search) | — | signed thumbs | S1 | U1 | — | BROWSER_CUSTOMER_SAFE |
| `/inventory/slabs` | yes | customer | slabs (op `listSlabs`) | archived_at via RPCs (ops `archiveSlab`, `unarchiveSlab`) | archive_slab, unarchive_slab, resolve_slab_inventory | — | slab-images signed thumbs (TTL 3600 s) | S1+S2 | U1 | — | BROWSER_CUSTOMER_SAFE |
| `/inventory/raw` | yes | customer | cards (op `listRawCards`) | none | — | scan-card (`list_cards`; server-signed thumbnails in V1) | card-scans read via edge-signed URLs | S1 | U1 | — | BROWSER_CUSTOMER_SAFE |
| `/slabs/:slabId` | yes | customer (admin extras) | slabs, slab_images, valuation_snapshots, slab_product_links, slab_product_candidates, slab_pricecharting_events, sold_comps, slab_comps (ops `getSlab`, `getPricingEvidence`, `listSoldComparables`) | archive/unarchive; confirmation (op `confirmAnalysis`); pricing refresh (admin op `refreshPricing`) | archive_slab, unarchive_slab, record_pricecharting_confirmation, apply_slab_pricing (admin path) | pricecharting-search (admin), market-intelligence (any authed, read-only) | slab-images signed URLs (TTL 3600 s) | S1+S2 (STALE_WRITE on stale pricing; RATE_LIMITED on provider pacing) | U1; NOT_FOUND for non-owned slab | hard delete is **not** part of this route's V2 surface (destructive firewall) | BROWSER_CUSTOMER_SAFE + BROWSER_ADMIN_GATED (refreshPricing) |
| `/raw-cards/:rawCardId` | yes | customer | cards, card_scans (op `getRawCard`) | card updates/archive via edge actions (V1: `update_card`, `archive_card`, `restore_card`) | — | scan-card (`get_card`, `card_summary`, mutations) | card-scans read (edge-signed) | S1+S2 | U1; NOT_FOUND for non-owned card | raw-card mutation actions not enumerated as manifest operations (edge multiplex) | BROWSER_CUSTOMER_SAFE |
| `/cards/:cardId` | yes | customer | slabs or cards — unified inventory-item resolution (ops `getSlab`/`getRawCard`) | none | resolve_inventory | — | signed URLs per item type | S1 | U1; NOT_FOUND | — | BROWSER_CUSTOMER_SAFE |
| `/pricing-evidence/:itemId` | **no** | customer | valuation_snapshots, slab_product_links, slab_product_candidates, slab_pricecharting_events, sold_comps, slab_comps (ops `getPricingEvidence`, `listSoldComparables`) | none | — | — | — | S1 | U1; NOT_FOUND | evidence aggregation is adapter-side (ADAPTER_REQUIRED); route file absent (nav hard-codes `/pricing-evidence/GCV-000101`) | BROWSER_CUSTOMER_SAFE |
| `/activity` | **no** | customer | audit_log — owner-read policy; admin sees all (op `listActivity`) | none | — | — | — | S1 | U1 | route file absent | BROWSER_CUSTOMER_SAFE |
| `/account` | **no** | customer | customer_profiles (op `getCurrentProfile`) | none | — | — | — | S1 | U1 | route file absent | BROWSER_CUSTOMER_SAFE |
| `/account/profile` | **no** | customer | customer_profiles (op `getCurrentProfile`) | **none possible** — customer_profiles writes are service_role-only (plan/status/limits are server-managed) | — | — | — | S1 (read-only) | U1 | route file absent; **no profile-update operation exists** — if editing is intended, a contract is missing by design decision | BROWSER_CUSTOMER_SAFE |
| `/account/security` | **no** | customer | auth:gotrue session | password change via `updateUser({password})` | — | — | — | S2 | U1 | route file absent; **no password-change operation in the manifest** | BROWSER_CUSTOMER_SAFE (gap) |
| `/account/subscription` | **no** | customer | none (op `getSubscriptionState`, status DEFERRED) | none | — | — | — | S0 (static placeholder) | U1 | **no billing/subscription backend exists** — ships as static placeholder per manifest | SECURITY_REVIEW_REQUIRED (DEFERRED) |
| `/account/integrations` | **no** | customer | none usable — all integration surfaces (eBay, marketplace) are admin-gated | none | — | — | — | S0/S1 placeholder | U1 | route file absent; no customer-facing integration operation exists | BROWSER_CUSTOMER_SAFE (placeholder) |

---

## 5. Admin routes (9)

| Route | In repo | Role | Reads | Writes | RPCs | Edge fns | Storage | States | Unauthorized | Missing contracts | Classification |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `/admin` | yes | admin | card_scan_reviews, card_scans (op `getAdminReviewQueue`) + adapter-aggregated summary counts | none | is_admin (role probe) | — | — | S1 | U2 | AdminSummary aggregation is adapter-side | BROWSER_ADMIN_GATED |
| `/admin/analysis` | **no** | admin | card_scan_reviews, card_scans (op `getAdminReviewQueue`) | card_scan_reviews resolution (op `resolveAdminReview` — direct RLS-gated update, adapter-wrapped) | — | analyze-slab (admin bulk analysis; admin quota fails open) | card-scans via edge-signed URLs | S1+S2 | U2 | route file absent; resolveAdminReview is ADAPTER_REQUIRED | BROWSER_ADMIN_GATED |
| `/admin/slabs` | **no** | admin | slabs — admin RLS sees all owners (op `listSlabs`) | archive/unarchive (ops) | archive_slab, unarchive_slab | — | slab-images signed URLs | S1+S2 | U2 | route file absent. **Destructive surface (purge_slabs, hard_delete_slab, cleanup-queue trio, get_slab_deletion_tombstone, slab_settings.allow_hard_delete toggle) exists backend-side but is deliberately excluded from the V2 provider** — see V2_SECURITY_BOUNDARIES.md §6–7 | BROWSER_ADMIN_GATED (destructive ops firewalled) |
| `/admin/raw-cards` | **no** | admin | cards (admin RLS), card_scan_reviews (ops `listRawCards`, `getAdminReviewQueue`) | review resolution (op `resolveAdminReview`) | — | scan-card admin actions | card-scans via edge-signed URLs | S1+S2 | U2 | route file absent | BROWSER_ADMIN_GATED |
| `/admin/pricing` | **no** | admin | pricecharting_marketplace_settings, pricecharting_offers, pricecharting_sync_runs (op `getMarketplaceState`) | slab pricing (op `refreshPricing` via apply_slab_pricing); offer mirror + slab lifecycle via edge | apply_slab_pricing; apply_pricecharting_offer_snapshot **only via edge** (browser EXECUTE excluded — V1 direct `.rpc()` call is dead, 42501) | pricecharting-search, pricecharting-marketplace (publish/details/sync_all) | — | S1+S2 (RATE_LIMITED, STALE_WRITE) | U2 | route file absent; **marketplace mutations (publish/sync) are not enumerated as manifest operations** (only `getMarketplaceState`/`refreshPricing` exist); apply_pricecharting_offer_snapshot is SECURITY_REVIEW_REQUIRED | BROWSER_ADMIN_GATED (+1 SECURITY_REVIEW_REQUIRED RPC) |
| `/admin/users` | **no** | admin | **none usable** — customer_profiles RLS is self-read only (no admin policy); no admin user-list RPC exists | account suspension etc. — no write path exists for browsers (customer_profiles writes are service_role-only) | — | — | — | n/a | U2 | route file absent; **no `listUsers`/user-admin operation in the manifest and no backend reader — entire surface is a missing contract** | BROWSER_ADMIN_GATED (unimplementable today) |
| `/admin/audit` | **no** | admin | audit_log — admin SELECT policy sees all rows (op `listActivity`, admin scope) | none (INSERT grant exists but is inert — no INSERT policy) | — | — | — | S1 | U2 | route file absent | BROWSER_ADMIN_GATED |
| `/admin/ebay` | **no** | admin | ebay_accounts, ebay_sync_cursors, ebay_inventory_locations, ebay_business_policies, ebay_sync_state, ebay_listing_intents, ebay_listing_mappings (ops `listEbayListings`, adapter reads); private.ebay_orders (op `listEbayOrders` — **no reader exists**) | OAuth connect (op `connectEbayAccount`); listing/sync/fulfillment mutations via edge fns | none directly (all eBay RPCs are SERVICE_ROLE_ONLY, called inside edge functions) | ebay-oauth-start, ebay-oauth-callback, ebay-account-sync, ebay-order-sync, ebay-finances-sync, ebay-list-item, ebay-revise-item, ebay-end-item, ebay-fulfillment, ebay-reference-search | slab-images read (listing images, service-side in edge) | S1+S2 (EBAY_NOT_CONNECTED, EBAY_RECONNECT_REQUIRED, EBAY_SYNC_BUSY) | U2 | route file absent; **listEbayOrders needs an is_admin-gated SECURITY DEFINER reader RPC** (BACKEND_CONTRACT_REQUIRED); listing/sync mutations not enumerated as manifest operations (edge multiplex); browser never sees tokens | BROWSER_ADMIN_GATED (+1 SECURITY_REVIEW_REQUIRED op) |
| `/builder` | **no** | admin | builder_runs, builder_steps, builder_approvals, builder_tool_calls, builder_audit_events (op `getBuilderRuns` — Phase 1 read-only spine) | **none** — run creation/approval DEFERRED until the builder write plane ships | — | — | — | S1 | U2 | route file absent; write plane deliberately deferred | BROWSER_ADMIN_GATED |

---

## 6. Missing-contract roll-up (what the manifest does not cover)

| Gap | Routes affected | Status |
|---|---|---|
| `signUp` / password-reset / password-change auth operations | `/sign-up`, `/forgot-password`, `/account/security` | Not in the 31-op manifest; V1 behavior documented in V2_STORAGE_AUTH_MATRIX.md §6 |
| Whitelisted slab-correction RPC (replaces arbitrary `Partial<Slab>` patch) | `/analysis/:analysisId`, `/slabs/:slabId` | `correctAnalysis` — BACKEND_CONTRACT_REQUIRED |
| CGC population read view/RPC + grant decision | (population features) | `getCgcPopulation` — BACKEND_CONTRACT_REQUIRED (tables API-unreachable today) |
| Admin eBay orders reader RPC (private schema) | `/admin/ebay` | `listEbayOrders` — BACKEND_CONTRACT_REQUIRED |
| Admin user-list/user-admin surface (no RLS policy, no RPC, no op) | `/admin/users` | Entirely missing |
| Marketplace/eBay mutation operations (publish, revise, end, sync, fulfillment) as enumerated ops | `/admin/pricing`, `/admin/ebay` | Edge functions exist; manifest enumerates only connect + reads |
| Raw-card mutation actions (`update_card`, `archive_card`, `restore_card`) as enumerated ops | `/raw-cards/:rawCardId` | scan-card edge multiplex; not in manifest |
| Billing/subscription backend | `/pricing`, `/account/subscription` | DEFERRED — static placeholder |
| Destructive surface (purge/hard-delete/cleanup/tombstone/settings toggle) | `/admin/slabs` | **Intentionally excluded** from the V2 provider — not a gap; see V2_SECURITY_BOUNDARIES.md |

---
## Addendum — contract v1.1.0 amendment (2026-07-27)
The operation manifest was amended from 31 to 35 operations after this document's body was authored: `signUp`, `requestPasswordReset`, and `updatePassword` were added (READY, auth:gotrue — covering /sign-up, /forgot-password, /account/security), and `getAdminUsers` was added (BACKEND_CONTRACT_REQUIRED — /admin/users has no backing today; see V2_INTEGRATION_GAPS G4). Operation counts in the body predate the amendment; `contracts/backend-capabilities.json` (v1.1.0) is canonical.

---
## Addendum — frontend main af02b063 (2026-07-27)
The 21-present/15-missing repo status in the body was measured at c4c55037 and is superseded: at af02b063 **all 36 intended routes exist** (37 total with /not-found; 10 public / 18 authenticated / 9 admin). Route guards remain mock UX-only. Backend mappings in the body are unchanged (they describe the backend, which did not move).
