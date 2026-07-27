# Lovable Integration Handoff — Graded Card Value V2

Source commit `ba3953fdb68c31435c7dac732f67d8d53aa2adcb` · contract version `1.1.0-ba3953fd-m65` · 2026-07-27.
Audience: whoever wires `Johnpriceofficial/slab-scribe-pro` to the real backend. Nothing here connects anything yet — production connection has explicit prerequisites (bottom).

## What Lovable receives

The generated snapshot at `src/integrations/backend/generated/` (already placed on the local `chore/v2-contract-consumer` branch):

| File | Purpose |
|---|---|
| `database.types.ts` | full Supabase types for the 65-migration schema — the row-shape source of truth |
| `backend-operations.ts` | the 35-operation typed surface (`OPERATIONS` manifest + request/response types + `BackendResult<T>`) |
| `backend-capabilities.json` | machine-readable manifest (generated — do not hand-edit) |
| `error-codes.ts` | the only error vocabulary the UI may surface |
| `CONTRACT_VERSION` | provenance: backend repo, commit, migration count, final migration, generation time, per-file SHA-256 |

Regeneration happens ONLY in the backend repo: `bun scripts/build-contract-snapshot.mjs --frontend <path>`; drift is checked by `bun scripts/validate-contracts.mjs --frontend <path>`. Treat the generated dir as read-only vendored output.

## BackendProvider method list

The repo's existing `src/integrations/backend/contracts.ts` (34 mock-backed provider ops; Lovable's own top-level `contracts/backend-operations.ts` lists 38 operation records) maps onto the generated surface as follows: implement the Supabase provider (`src/integrations/supabase/provider.ts`, currently throwing `backend_contract_required`) method-by-method against the generated `OPERATIONS`:

- **Implement now (25 READY):** getSession, signIn, signUp, requestPasswordReset, updatePassword, signOut, getCurrentProfile, listSlabs, getSlab, listRawCards, getRawCard, archiveSlab, unarchiveSlab, createSlabIntake, createRawCardIntake, startSlabAnalysis, getAnalysis, confirmAnalysis, listSoldComparables, listActivity, getAdminReviewQueue, getMarketplaceState, connectEbayAccount, listEbayListings, getBuilderRuns.
- **Implement with adapter logic (5):** getDashboardSummary (client aggregation), uploadSlabImage (upload+register+HEIC as one flow), getPricingEvidence (4-table view-model), refreshPricing (edge search → apply RPC, RATE_LIMITED/STALE_WRITE mapping), resolveAdminReview (typed wrapper over the admin-RLS update).
- **Keep throwing `backend_contract_required` (4):** correctAnalysis, getCgcPopulation, listEbayOrders, getAdminUsers — until the G1–G4 backend contracts in `docs/V2_INTEGRATION_GAPS.md` ship.
- **Static placeholder (1):** getSubscriptionState.

Alignment notes from the survey: reconcile the generated `error-codes.ts` with the hand-written `src/integrations/backend/errors.ts` union (map generated SCREAMING_CASE codes into the existing retry logic — do not maintain two vocabularies); the existing `contract-manifest.ts` (`expectedContract: null` × 32) should be filled from `backend-capabilities.json`, not hand-typed; money stays cents-based per `src/types/*` — `database.types.ts` provides row shapes, the domain mappers stay.

## Zod validation requirements

- Validate EVERY provider request before any network call (`VALIDATION_FAILED` on failure) and every response at the trust boundary — schema per operation, colocated with the provider method.
- Zod ^3.24 is already installed; add `zodResolver` wiring for forms (installed but unused today).
- Never `.passthrough()` on write payloads — whitelists only (this is the exact failure mode G1 exists to fix on the backend side).
- Route params (`/slabs/:slabId` etc.): add `validateSearch`/param schemas — none exist today.

## Environment-mode requirements

- `BACKEND_MODE`: `mock` (default, today's behavior) | `staging` | `production`. The provider factory in `provider.ts` currently routes everything to mock — keep that until staging exists.
- Supabase URL + anon key via env names only (no values in the repo). The guard comment in `supabase/provider.ts` forbidding live connections to `rcbwemkfcefarqnlgrmv` stays until the production-connection prerequisites below are met.
- `@supabase/supabase-js` is NOT yet a dependency; adding it will hit bunfig's 24h `minimumReleaseAge` guard — pick a released version ≥24h old.
- JSON import caveat: tsconfig lacks `resolveJsonModule`; import the manifest from `backend-operations.ts` (typed) rather than the JSON, or enable the flag deliberately.

## Mock-to-staging replacement order

1. Auth + profile (getSession/signIn/signOut/getCurrentProfile) — smallest real vertical, exercises hCaptcha + the auth state machine.
2. Read-only inventory (listSlabs/getSlab + signed image URLs) — **recommended first staging vertical slice** together with step 1.
3. Intake + upload (createSlabIntake/uploadSlabImage).
4. Analysis (startSlabAnalysis via scan-card, getAnalysis, confirmAnalysis).
5. Pricing evidence + comparables (+ refreshPricing for admins).
6. Admin surfaces (review queue, marketplace state, builder reads).
7. eBay (connect + listings; orders wait for G3) — sandbox only.

Each step: swap one provider section from mock → staging behind `BACKEND_MODE`, keep the mock for `/demo` and tests.

## Production connection prerequisites (all must hold — none are met by this milestone)

1. G1 (correctAnalysis RPC) shipped, or the correction UI disabled.
2. S1 (`apply_pricecharting_offer_snapshot`) resolved.
3. Staging validation complete per `docs/V2_STAGING_PLAN.md` (branch approval + limit change are their own approvals).
4. Contract drift validation green against the deployed backend commit.
5. Explicit operator authorization to point Lovable at `rcbwemkfcefarqnlgrmv` and to remove the provider guard comment.
6. Route guards hardened: all 36 intended routes exist as of af02b063 (37 with /not-found), but `_authed`/`_admin` guards are mock UX-only — real session/admin gating must land with the provider wiring.

## Reconciliation vs frontend main af02b063 (2026-07-27)

The consumer branch was rebuilt on origin/main after 41 Lovable commits. Canonical counts: **37 routes (10 public / 18 authenticated / 9 admin — every intended route present)**; **34 BackendProvider ops**, **38 records in Lovable's `contracts/backend-operations.ts`**, vs the backend manifest's **35**. Mapping: 28 aligned (incl. 2→1 collapses onto getAnalysis/uploadSlabImage and 1→2 splits for slab/raw-card variants). Frontend-only ops (10): getCurrentPermissions, searchInventory, addConfirmedSlab, getCurrentValuation, getValuationHistory, getPricingWarnings, publishListing (DEFERRED), getAdminSummary, getPricingReviewQueue, updateProfile — six are adapter-composable; getValuationHistory / getPricingReviewQueue / updateProfile / publishListing are genuine contract gaps to fold into the G-list at next contract rev. Backend-only ops unconsumed by the provider (7): signUp (route exists, op missing), unarchiveSlab, getCgcPopulation, listEbayOrders, connectEbayAccount, refreshPricing, resolveAdminReview. Wiring deltas for Lovable: generated/index.ts placeholder expects `operations.ts` (drop-in ships `backend-operations.ts`) and still exports `GENERATED_CONTRACT_PRESENT=false` — flip + re-export is a Lovable-side edit; `errors.ts` and the generated `error-codes.ts` both export `BackendErrorCode`/`BackendError` (class vs interface, `retryable` vs `retriable`) — import-alias at the boundary; zero literal overlap between the 11 lowercase frontend codes and the 23 generated codes (9 map semantically, 14 domain codes unrepresented). `response-schemas.ts` (Zod, 7/34 ops) is complementary post-adapter validation, untouched.
