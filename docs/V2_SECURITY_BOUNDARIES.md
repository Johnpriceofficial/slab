# V2 Security Boundaries — Graded Card Value

> **Source commit:** `ba3953fdb68c31435c7dac732f67d8d53aa2adcb` · **Schema state:** 65 migrations (20260709000000..20260904000000) · **Contract version:** `1.0.0-ba3953fd-m65` · **Date:** 2026-07-27
>
> **Generated documentation of existing behavior — not a change proposal.** Defines the browser-safe vs edge-only vs service-only vs destructive boundaries the V2 provider must respect. All classifications were verified against live production function bodies (`pg_get_functiondef`) and grants (`aclexplode(proacl)`) — never inferred from grants alone.

Companion docs: [V2_BACKEND_CONTRACTS.md](V2_BACKEND_CONTRACTS.md), [V2_ROUTE_BACKEND_MAP.md](V2_ROUTE_BACKEND_MAP.md), [V2_EDGE_FUNCTION_CONTRACTS.md](V2_EDGE_FUNCTION_CONTRACTS.md), [V2_STORAGE_AUTH_MATRIX.md](V2_STORAGE_AUTH_MATRIX.md).

---

## 1. Classification model and counts

60 RPC-callable public functions, classified:

| Classification | Meaning for the V2 provider | Count |
|---|---|---|
| BROWSER_CUSTOMER_SAFE | Callable from the browser with a customer JWT; in-body/RLS owner-or-admin enforcement | **16** |
| BROWSER_ADMIN_GATED | Callable from the browser, but only useful/permitted for admins (`is_admin()` in-body) | **4** |
| EDGE_FUNCTION_ONLY | service_role EXECUTE; only meaningful inside an Edge Function request cycle (quota, pacing, telemetry); sole repo callers are `supabase/functions/_shared` | **4** |
| SERVICE_ROLE_ONLY | service_role EXECUTE; backend-internal (eBay credentials/sync/persist, builder audit, maintenance) — the browser must never reach these | **27** |
| DESTRUCTIVE_ADMIN_ONLY | Irreversible data destruction behind the break-glass firewall (§6) | **2** |
| INTERNAL_ONLY | Helpers/predicates, disabled stubs, postgres-only maintenance — no V2 surface | **6** |
| SECURITY_REVIEW_REQUIRED | Grant/body/call-site contradiction that the bridge must resolve (§10) | **1** |
| **Total** | | **60** |

Plus 15 trigger functions + 1 event trigger (not PostgREST-callable — internal by construction).

## 2. Full function → classification table

| Function | Classification |
|---|---|
| apply_slab_pricing | BROWSER_CUSTOMER_SAFE |
| archive_slab | BROWSER_CUSTOMER_SAFE |
| check_slab_certification | BROWSER_CUSTOMER_SAFE |
| create_slab | BROWSER_CUSTOMER_SAFE |
| is_admin | BROWSER_CUSTOMER_SAFE |
| link_ai_analysis_run | BROWSER_CUSTOMER_SAFE |
| normalize_cert | BROWSER_CUSTOMER_SAFE (pure utility) |
| normalize_grader | BROWSER_CUSTOMER_SAFE (pure utility) |
| parse_inventory_code | BROWSER_CUSTOMER_SAFE (pure utility) |
| pricecharting_game_url | BROWSER_CUSTOMER_SAFE (pure utility) |
| record_pricecharting_confirmation | BROWSER_CUSTOMER_SAFE |
| resolve_inventory | BROWSER_CUSTOMER_SAFE |
| resolve_slab_inventory | BROWSER_CUSTOMER_SAFE |
| stage_raw_card | BROWSER_CUSTOMER_SAFE |
| unarchive_slab | BROWSER_CUSTOMER_SAFE |
| valid_image_ext | BROWSER_CUSTOMER_SAFE (pure utility) |
| acknowledge_slab_storage_cleanup | BROWSER_ADMIN_GATED |
| get_slab_deletion_tombstone | BROWSER_ADMIN_GATED |
| list_pending_slab_storage_cleanup | BROWSER_ADMIN_GATED |
| record_slab_storage_cleanup_failure | BROWSER_ADMIN_GATED |
| consume_daily_quota | EDGE_FUNCTION_ONLY |
| consume_user_daily_quota | EDGE_FUNCTION_ONLY |
| ebay_api_run_record | EDGE_FUNCTION_ONLY |
| reserve_api_request_slot | EDGE_FUNCTION_ONLY |
| builder_append_audit_event | SERVICE_ROLE_ONLY |
| ebay_business_policies_replace | SERVICE_ROLE_ONLY |
| ebay_credential_scopes_get | SERVICE_ROLE_ONLY |
| ebay_credential_scopes_set | SERVICE_ROLE_ONLY |
| ebay_finance_transactions_apply | SERVICE_ROLE_ONLY |
| ebay_inventory_locations_replace | SERVICE_ROLE_ONLY |
| ebay_listing_reconcile_local | SERVICE_ROLE_ONLY |
| ebay_oauth_credential_get | SERVICE_ROLE_ONLY |
| ebay_oauth_credential_rotate | SERVICE_ROLE_ONLY |
| ebay_oauth_credential_upsert | SERVICE_ROLE_ONLY |
| ebay_oauth_state_consume | SERVICE_ROLE_ONLY |
| ebay_oauth_state_create | SERVICE_ROLE_ONLY (legacy — no runtime caller) |
| ebay_oauth_state_create_single_flight | SERVICE_ROLE_ONLY |
| ebay_oauth_state_get | SERVICE_ROLE_ONLY |
| ebay_orders_persist | SERVICE_ROLE_ONLY |
| ebay_publish_lease_acquire | SERVICE_ROLE_ONLY |
| ebay_publish_lease_assert_and_extend | SERVICE_ROLE_ONLY |
| ebay_publish_lease_release | SERVICE_ROLE_ONLY |
| ebay_sales_apply | SERVICE_ROLE_ONLY |
| ebay_sync_complete | SERVICE_ROLE_ONLY |
| ebay_sync_cursor_touch | SERVICE_ROLE_ONLY |
| ebay_sync_lease_acquire | SERVICE_ROLE_ONLY |
| ebay_sync_lease_assert_and_extend | SERVICE_ROLE_ONLY |
| ebay_sync_lease_release | SERVICE_ROLE_ONLY |
| ebay_sync_state_fail | SERVICE_ROLE_ONLY |
| ebay_sync_state_load | SERVICE_ROLE_ONLY |
| reconcile_stale_exact_api_tier | SERVICE_ROLE_ONLY (no runtime caller found) |
| hard_delete_slab | DESTRUCTIVE_ADMIN_ONLY |
| purge_slabs | DESTRUCTIVE_ADMIN_ONLY |
| can_access_slab | INTERNAL_ONLY (auth predicate helper) |
| cgc_claim_import_run | INTERNAL_ONLY (postgres-only EXECUTE) |
| compact_slab_inventory_ids | INTERNAL_ONLY (disabled — raises unconditionally) |
| reassign_slab_inventory_id | INTERNAL_ONLY (disabled — raises unconditionally) |
| slab_object_owner | INTERNAL_ONLY (storage-policy helper) |
| slab_owner | INTERNAL_ONLY (policy helper) |
| apply_pricecharting_offer_snapshot | **SECURITY_REVIEW_REQUIRED** (§10) |

## 3. Operation-level review flags (distinct from the RPC table above)

`contracts/backend-operations.ts` additionally marks 4 of its 31 **operations** SECURITY_REVIEW_REQUIRED — these are contract-surface flags, not RPC grant contradictions:

| Operation | Why flagged | Status |
|---|---|---|
| `correctAnalysis` | V1 patches `slabs` with an unwhitelisted `Partial<Slab>`; needs a whitelisted correction RPC | BACKEND_CONTRACT_REQUIRED |
| `getCgcPopulation` | Admin-read RLS policies exist but no client grants — surface is postgres-internal today | BACKEND_CONTRACT_REQUIRED |
| `listEbayOrders` | Orders live in `private` with deny-all RLS; no admin reader RPC exists | BACKEND_CONTRACT_REQUIRED |
| `getSubscriptionState` | No billing backend exists at all | DEFERRED |

## 4. Storage boundary (condensed from V2_STORAGE_AUTH_MATRIX.md)

- Two buckets, both **private** (`public=false`): `slab-images` (15 MB; jpeg/png/webp/heic/heif) and `card-scans` (10 MB; jpeg only). MIME/size limits are enforced by Supabase Storage for **every** uploader including admins (integration-test proven).
- Exactly 6 policies on `storage.objects`:
  - `slab-images`: SELECT/INSERT/UPDATE/DELETE for `authenticated` where `is_admin(auth.uid()) OR slab_object_owner(name) = auth.uid()` — access derives from **slab row ownership** (path `slabs/<inventory_number>/…`), not the storage owner column.
  - `card-scans`: SELECT/INSERT only, folder segment 1 must equal `auth.uid()` — **no client UPDATE or DELETE exists for anyone** (admins get no extra card-scans access).
- `anon` can do nothing in either bucket. `service_role` bypasses RLS (edge functions sign raw-card URLs server-side).
- Paths: `slab-images` paths are **server-assigned** by `create_slab`; `card-scans` paths are client-built but policy+RPC double-checked (`<uid>/<uuid>.jpg`).
- All browser reads are signed URLs, TTL 3600 s in practice. No signed-upload-URL flow exists; uploads are direct with the user JWT, `upsert:false` everywhere.

## 5. Auth boundary

- **Single authority for adminship:** `is_admin(uuid)` reads `auth.users.raw_app_meta_data->>'graded_card_value_admin'` — app metadata, immutable to the user, set server-side only.
- **`slab_admins` is legacy/aux:** the table still exists (with an admin-ALL policy and residual anon grants) but `is_admin()` does NOT consult it. V2 must not build admin checks on it.
- Customer identity: RLS owner scoping (`owner_id`/`created_by` = `auth.uid()`) plus in-body `can_access_slab` (owner-or-admin) in RPCs.
- Suspension is **per-operation, not auth-level**: `create_slab` and `stage_raw_card` refuse non-active `customer_profiles.account_status` (42501); `consume_user_daily_quota` only matches active profiles (scans fail as quota-denied). Owner-scoped reads and signed URLs are NOT revoked by suspension (documented V1 behavior; the contract layer must decide whether that is intended).
- `customer_profiles` is self-read-only (no admin read policy) and all writes are service_role — there is no browser path to alter plan/status/limits.
- Minor disclosures (documented, backlog §11): any authenticated user can call `is_admin(uuid)` for arbitrary uuids (admin-flag probing), and `slab_owner`/`slab_object_owner` map slab ids/paths to owner uuids.

## 6. Destructive-operation firewall

The only irreversible-deletion path is `purge_slabs` (with `hard_delete_slab` as a thin non-SECURITY-DEFINER SQL wrapper — safe because every gate lives inside `purge_slabs`):

| Gate | Enforcement |
|---|---|
| 1. Admin | `is_admin(auth.uid())` in-body (42501 otherwise) |
| 2. Break-glass flag | `slab_settings.allow_hard_delete = true` required (else HARD_DELETE_DISABLED 42501). **Currently `false` in production** — the firewall is closed at rest; an admin must flip the flag first. |
| 3. Input integrity | Non-empty id array; all ids must exist and be distinct (P0002) |
| 4. Serialization | Advisory lock 918273646; at-most-once (retry after success raises P0002) |
| Evidence before deletion | Immutable `private.slab_deletion_tombstones` (conflict-do-nothing), `audit_log` 'hard_delete' rows, and every related storage path enqueued into `private.slab_storage_cleanup_queue` (incl. a `storage.objects` prefix scan) — tombstones + audit rows are retained by design; `get_slab_deletion_tombstone` (admin-gated) is the only read path |

**V2 boundary: purge_slabs and hard_delete_slab are NEVER exposed to the V2 provider.** No operation in the 31-op manifest references them, and slab-scribe-pro's `hardDelete` feature flag is `false`. (V1 `src/lib/slabs/data.ts` / `inventory-maintenance.ts` still call them directly — a V1-only surface.)

## 7. Cleanup-queue boundary

- The trio `list_pending_slab_storage_cleanup` / `acknowledge_slab_storage_cleanup` / `record_slab_storage_cleanup_failure` is admin-gated in-body (BROWSER_ADMIN_GATED).
- Protocol invariant: the actual Storage object deletion happens **client-side between list and acknowledge**; `acknowledge` deletes queue rows and trusts that the objects are really gone. Correct order: delete objects → acknowledge; report failures via `record_…_failure` (attempts counter increments by design).
- **V2 boundary: queue consumption is not an authorized V2 surface** — no manifest operation exposes the trio, so the V2 provider cannot drain the queue. It remains a V1/ops-tooling concern until an operation is deliberately added.

## 8. eBay credential boundary

- Refresh tokens exist **only encrypted** in `private.ebay_oauth_credentials`; `ebay_oauth_credential_get` returns ciphertext (decryption happens inside edge functions); rotation is compare-and-swap on the prior ciphertext (race-safe).
- OAuth states are single-flight per user (advisory lock; creating a new state expires the user's others) and single-use (`consume` sets `consumed_at` once).
- All 9 credential/state RPCs are **service_role EXECUTE only** — no browser path exists. The browser's entire eBay surface is: admin-JWT edge-function calls (`ebay-oauth-start`, seller-operation dispatch) and admin-RLS reads of public mirror tables. **The browser never sees a token, encrypted or plain.** Buyer PII stays in `private.ebay_orders` (deny-all, no reader RPC today).
- `ebay-oauth-callback` runs with `verify_jwt=false` (browser redirect from eBay) but is gated by the single-use hashed `state` + code exchange (see V2_EDGE_FUNCTION_CONTRACTS.md).

## 9. Edge-only quota boundary

`consume_daily_quota`, `consume_user_daily_quota`, `reserve_api_request_slot`, `ebay_api_run_record` are service_role-only and meaningful only inside an edge request cycle. Their backing tables (`api_daily_usage`, `api_rate_limits`, `api_user_daily_usage`) are deny-all by design. Customer scan quota **fails closed**; admin bulk-analysis quota fails open (documented edge behavior).

## 10. The single SECURITY_REVIEW_REQUIRED RPC

**`apply_pricecharting_offer_snapshot` — three-way grant/body/call-site mismatch:**

| Layer | Says |
|---|---|
| EXECUTE grant | service_role + postgres **only** |
| Function body | `is_admin(auth.uid()) OR auth.role() = 'service_role'` — anticipates browser-admin callers |
| Call sites | V1 `src/lib/slabs/data.ts:481` calls it via `.rpc()` with the user's JWT → **must fail 42501 at runtime**; edge `pricecharting-marketplace` also calls it (that path works) |

The bridge must pick the intended contract: either grant `authenticated` EXECUTE (the body gate is already admin-safe) or delete the frontend direct call and route exclusively through the `pricecharting-marketplace` edge function. Until decided, the V2 provider treats it as **edge-internal only** (no manifest operation calls it directly).

## 11. Hardening backlog (documented facts, no changes made)

| # | Item | Facts |
|---|---|---|
| 1 | **Latent TRUNCATE grants** | `authenticated` holds TRUNCATE on nearly every public table (incl. `slabs`); `anon` holds residual REFERENCES/TRIGGER/TRUNCATE on 6 tables (`ebay_listing_intents`, `ebay_sync_state`, `pricecharting_marketplace_settings`, `slab_admins`, `slab_pricecharting_events`, `slab_settings`). TRUNCATE is **not** subject to RLS. PostgREST exposes no TRUNCATE verb, so this is latent, not remotely exploitable — but any future SQL-adjacent surface would inherit it. Revoke is the standing hardening item. |
| 2 | Inert CGC policies | `cgc_population_*` admin-read policies have no matching table grants (not even service_role) — dead policies; surface is postgres-internal. |
| 3 | `private.ebay_fulfillments` has no writer | No RPC or edge-function code touches it; only migrations reference it. |
| 4 | Dead/disabled call sites | V1 still calls `reassign_slab_inventory_id`/`compact_slab_inventory_ids` (permanently disabled stubs — always 42501) and the dead `apply_pricecharting_offer_snapshot` browser path. |
| 5 | Admin-flag probing | `is_admin(uuid)` is callable by any authenticated user for arbitrary uuids; `slab_owner`/`slab_object_owner` map ids/paths to owner uuids. Minor info disclosure. |
| 6 | `audit_log` INSERT grant inert | `authenticated` has INSERT grant but no INSERT policy — inert today; tidy-up candidate. |

---
## Addendum — contract v1.1.0 amendment (2026-07-27)
The operation manifest was amended from 31 to 35 operations after this document's body was authored: `signUp`, `requestPasswordReset`, and `updatePassword` were added (READY, auth:gotrue — covering /sign-up, /forgot-password, /account/security), and `getAdminUsers` was added (BACKEND_CONTRACT_REQUIRED — /admin/users has no backing today; see V2_INTEGRATION_GAPS G4). Operation counts in the body predate the amendment; `contracts/backend-capabilities.json` (v1.1.0) is canonical.
