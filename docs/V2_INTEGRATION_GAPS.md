# V2 Integration Gaps

Source commit `ba3953fdb68c31435c7dac732f67d8d53aa2adcb` · 65 migrations (`20260709000000..20260904000000`) · contract version `1.1.0-ba3953fd-m65` · 2026-07-27.
Nothing in this document is implemented in this milestone — it is the specification of what the bridge found missing, ambiguous, or deferred.

## Integration status totals (35 frontend operations, contract v1.1.0)

| Status | Count | Operations |
|---|---|---|
| READY | 25 | getSession, signIn, signUp, requestPasswordReset, updatePassword, signOut, getCurrentProfile, listSlabs, getSlab, listRawCards, getRawCard, archiveSlab, unarchiveSlab, createSlabIntake, createRawCardIntake, startSlabAnalysis, getAnalysis, confirmAnalysis, listSoldComparables, listActivity, getAdminReviewQueue, getMarketplaceState, connectEbayAccount, listEbayListings, getBuilderRuns |
| ADAPTER_REQUIRED | 5 | getDashboardSummary, uploadSlabImage, getPricingEvidence, refreshPricing, resolveAdminReview |
| BACKEND_CONTRACT_REQUIRED | 4 | correctAnalysis, getCgcPopulation, listEbayOrders, getAdminUsers |
| DEFERRED | 1 | getSubscriptionState |

Total 35 = 25 + 5 + 4 + 1. (v1.1.0 amendment: signUp/requestPasswordReset/updatePassword added to cover /sign-up, /forgot-password, /account/security; getAdminUsers added because /admin/users has no possible backing today.) No operation carries the SECURITY_REVIEW_REQUIRED *status*; security-review items are tracked at the RPC/classification level below. The canonical counts are the generated `backend-capabilities.json`; `scripts/validate-contracts.mjs` guarantees it matches `backend-operations.ts`.

## BACKEND_CONTRACT_REQUIRED items

### G1 — `correctAnalysis`: whitelisted slab-correction RPC
- **Frontend use case:** human correction of AI-derived identity fields on `/analysis/:analysisId` and `/slabs/:slabId`.
- **Missing capability:** V1 patches `public.slabs` with an unwhitelisted `Partial<Slab>` via PostgREST; any RLS-updatable column can be written from the browser. The V2 contract must not reproduce that.
- **Recommended interface:** RPC `correct_slab_fields(p_slab_id uuid, p_corrections jsonb)` — SECURITY DEFINER, in-body owner-or-admin gate, an explicit column whitelist (card_name, set_name, card_number, year, language, rarity, variation, grade, grade_label, finish, game_or_franchise), rejection of unknown keys, and an audit row.
- **Request/response:** `CorrectAnalysisRequest` → corrected `SlabRow` (jsonb).
- **Authorization:** `owner_id = auth.uid() OR is_admin(auth.uid())`, suspension check consistent with `create_slab`.
- **Side effects:** slab field updates; identity re-derivation triggers fire; audit append.
- **Migration requirement:** yes — one new migration (next free version ≥ 20260905000000) + regenerate types + snapshot.
- **Test requirement:** static contract test + behavioral integration test (owner corrects, non-owner denied, unknown key rejected, audit row present).
- **Security risk if unaddressed:** browser can write any updatable slab column (integrity, not confidentiality).
- **Launch priority:** HIGH — blocks the analysis-correction vertical.

### G2 — `getCgcPopulation`: population read surface
- **Frontend use case:** population display on `/slabs/:slabId` and `/pricing-evidence/:itemId`.
- **Missing capability:** `cgc_population_*` tables have admin-read policies but **no client grants** — the whole surface is postgres-internal today; no browser or even admin read path exists.
- **Recommended interface:** either (a) `GRANT SELECT` to authenticated on the three `cgc_population_*` tables (policies already restrict rows) — smallest change; or (b) a read RPC `get_cgc_population(p_card_query jsonb)` if row-level exposure should stay curated. Decision needed: population data is not customer-owned — if it should be visible to all customers, the policies must also change from admin-read to authenticated-read. **Grant/policy decision required before any exposure.**
- **Request/response:** card identity query → population rows (set, card, grade counts).
- **Authorization:** to be decided (admin-only vs all customers).
- **Side effects:** none (read-only).
- **Migration requirement:** yes (grants and/or policy + optional RPC).
- **Test requirement:** integration test for the chosen audience matrix.
- **Security risk:** low (population data is public-ish reference data), but the audience decision is a product call.
- **Launch priority:** MEDIUM — the slab detail page degrades gracefully without it.

### G3 — `listEbayOrders`: admin order reader
- **Frontend use case:** `/admin/ebay` orders view.
- **Missing capability:** orders live in `private.ebay_orders` / `private.ebay_order_line_items` (deny-all RLS, no grants); the persist RPCs are service-role writers; **no reader RPC exists** for any browser role.
- **Recommended interface:** RPC `admin_list_ebay_orders(p_account_id uuid, p_limit int, p_offset int)` — SECURITY DEFINER, in-body `is_admin` gate, returns a redacted order projection (no buyer PII beyond what the admin surface needs), plus `admin_get_ebay_order(p_order_id text)` for detail.
- **Request/response:** pagination request → order rows + line items.
- **Authorization:** `is_admin(auth.uid())` in-body; EXECUTE to authenticated.
- **Side effects:** none (read-only).
- **Migration requirement:** yes + types + snapshot regeneration.
- **Test requirement:** admin reads, non-admin denied, anon denied; redaction assertions.
- **Security risk:** order data contains marketplace PII — the projection must be deliberate.
- **Launch priority:** MEDIUM — only blocks the admin orders pane; listings/sync panes are READY.

### G4 — `getAdminUsers`: admin user listing
- **Frontend use case:** `/admin/users` — account overview, suspension management.
- **Missing capability:** `customer_profiles` RLS is self-read-only (no admin policy); no admin user-list RPC exists; `/admin/users` is unimplementable today.
- **Recommended interface:** either an admin RLS policy (`is_admin(auth.uid())` SELECT on customer_profiles) — smallest change — or an `admin_list_users(p_limit int, p_offset int)` SECURITY DEFINER RPC returning a deliberate projection (id, email-safe fields, suspension state, counts). Suspension *toggling* is a separate write contract to specify with it.
- **Authorization:** is_admin in policy or in-body.
- **Side effects:** none (read); the companion suspension write mutates customer_profiles + audit.
- **Migration requirement:** yes + types + snapshot.
- **Test requirement:** admin reads, non-admin/anon denied; suspension-write audit assertions if included.
- **Security risk:** profile PII exposure — projection must be deliberate.
- **Launch priority:** MEDIUM — admin can launch without the users pane.

## SECURITY_REVIEW_REQUIRED

### S1 — `apply_pricecharting_offer_snapshot` (three-way mismatch)
EXECUTE is service_role-only; the live body permits browser admins (`is_admin OR service_role`); V1 `src/lib/slabs/data.ts` calls it with the user JWT — a call that must fail 42501 today. Resolve one way: (a) grant authenticated EXECUTE (body gate already admin-safe) or (b) delete the frontend call and route through the `pricecharting-marketplace` edge function. Recommendation: **(b)** — keeps offer-snapshot writes on the edge path with provider pacing. Decision + one small change required before the marketplace admin vertical.

### S2 — Edge-layer notes for the review backlog (from V2_EDGE_FUNCTION_CONTRACTS.md)
- `ebay-fulfillment` has no idempotency key — a retry could double-submit ship/refund at eBay. V2 provider must never auto-retry it (error-codes marks it non-retriable); a provider-side idempotency key is the proper fix.
- `sync_all` (marketplace) has no lease — concurrent scheduler+admin runs can overlap. Not a V2 blocker (scheduler is not enabled), but note before any scheduler activation.
- `market-intelligence` is absent from config.toml (implicit verify_jwt=true) and uses a divergent error envelope — the adapter normalizes it; adding it to config.toml is a one-line hygiene item.
- Latent TRUNCATE grants for authenticated (most public tables) and anon (6 tables) — RLS-exempt but not PostgREST-reachable; belongs to the standing grant-hardening review backlog, not this bridge.

## ADAPTER_REQUIRED items (no backend change; provider-side work in slab-scribe-pro)

| Operation | Adapter work |
|---|---|
| getDashboardSummary | aggregate slabs/cards/valuations client-side; future summary RPC optional |
| uploadSlabImage | wrap storage upload + `slab_images` registration + HEIC normalization as one transaction-like flow with rollback-on-failure semantics |
| getPricingEvidence | join 4 owner-readable tables into one evidence view-model |
| refreshPricing | orchestrate edge search + apply RPC; map RATE_LIMITED / STALE_WRITE |
| resolveAdminReview | wrap the admin-RLS table update behind a typed method |

## DEFERRED

| Item | Reason |
|---|---|
| getSubscriptionState (/account/subscription) | no billing backend exists — static placeholder at launch |
| /demo route content | product decision; no backend dependency |
| builder write plane (run creation/approval from /builder) | read-only spine only; write connectors intentionally unprovisioned |
| eBay listing/revise/end/fulfillment UI verticals | READY at the edge layer but gated by confirmation phrases + flags; sequence after core inventory verticals |

## Ambiguities resolved by this bridge (no action needed)
- `is_admin()` reads `app_metadata.graded_card_value_admin`; `slab_admins` is legacy — V2 must not read it.
- `pricecharting-sync` edge function is a legacy alias with no caller — excluded from the contract surface.
- `reassign_slab_inventory_id` / `compact_slab_inventory_ids` raise unconditionally (INTERNAL_ONLY, permanently disabled) — excluded.
- Derivative storage paths: no `derivatives/` folder exists; derivative rows point at main object paths — the adapter must not synthesize paths.
