# V2 Backend Contracts — Graded Card Value

> **Source commit:** `ba3953fdb68c31435c7dac732f67d8d53aa2adcb` · **Schema state:** 65 migrations (20260709000000..20260904000000) · **Contract version:** `1.0.0-ba3953fd-m65` · **Date:** 2026-07-27
>
> **Generated documentation of existing behavior — not a change proposal.** Facts were read from the live production project (`rcbwemkfcefarqnlgrmv`) catalog and function bodies, cross-checked against `supabase/migrations/` at the commit above. Where behavior is surprising it is flagged, not "fixed".

Companion docs: [V2_EDGE_FUNCTION_CONTRACTS.md](V2_EDGE_FUNCTION_CONTRACTS.md) (18 edge functions), [V2_STORAGE_AUTH_MATRIX.md](V2_STORAGE_AUTH_MATRIX.md) (buckets, storage policies, auth flows), [V2_ROUTE_BACKEND_MAP.md](V2_ROUTE_BACKEND_MAP.md) (routes → backend), [V2_SECURITY_BOUNDARIES.md](V2_SECURITY_BOUNDARIES.md) (classification boundaries).

---

## 1. Source of truth

| Artifact | Role | Authority |
|---|---|---|
| `supabase/migrations/` (65 files, `20260709000000..20260904000000`) | Canonical schema definition | **Canonical.** Live production is these migrations applied in order; live catalog was cross-checked against them. |
| `contracts/backend-operations.ts` | Authored, typed 31-operation manifest (`OPERATIONS`, `CONTRACT_VERSION`) the V2 frontend consumes | Authored bridge. Edited by hand; the single frontend-facing surface. |
| `contracts/database.types.ts` | Generated row types for browser-visible tables | Generated from schema. |
| `contracts/error-codes.ts` | Authored stable `BackendErrorCode` enum + `BackendError` shape | Authored bridge. The only error surface the V2 UI sees. |
| `contracts/backend-capabilities.json` | Machine-readable capability snapshot | **Generated** from `backend-operations.ts` by `scripts/build-contract-snapshot.mjs` — edit the TS manifest, never the JSON. |
| `scripts/validate-contracts.mjs` | Drift enforcement | Fails when the manifest, the generated JSON, and the schema state disagree. |

Rules that fall out of this: migrations define reality; `contracts/` is the generated+authored bridge that describes it; drift between the two is a build failure, not a runtime discovery.

---

## 2. Public schema — 48 tables (grouped by domain)

RLS is enabled on **48/48** public tables (event trigger `rls_auto_enable` force-enables RLS on any new public table). 45/48 have policies; all policies target role `authenticated` only. **anon has zero SELECT anywhere.** 3 tables are deny-all by design. Grant legend: S=SELECT I=INSERT U=UPDATE D=DELETE T=TRUNCATE R=REFERENCES G=TRIGGER; "full" = all seven.

### 2.1 Core inventory (slabs + raw cards) — 4 tables

| Table | Purpose | Owner col | RLS (authenticated) | authenticated grants |
|---|---|---|---|---|
| `slabs` | Core graded-slab inventory (identity, grading, valuation, pricing, images, lifecycle) | owner_id | ALL: owner or admin | full |
| `cards` | Raw (ungraded) card inventory from the live scanner | created_by | SELECT + UPDATE: created_by or admin | R,S,G,T,U |
| `card_scans` | Immutable-ish audit evidence for in-browser camera captures | created_by | SELECT: created_by | R,S,G,T |
| `card_scan_reviews` | Pending low-confidence/duplicate scanner decisions awaiting operator action | created_by | SELECT: created_by | R,S,G,T |

### 2.2 AI analysis — 2 tables

| Table | Purpose | Owner col | RLS (authenticated) | authenticated grants |
|---|---|---|---|---|
| `ai_analysis_runs` | AI slab-analysis run records; linked to a slab post-hoc | owner_id | ALL: owner or admin | I,R,S,G,T |
| `ai_field_evidence` | Per-field AI extraction evidence rows per run | owner_id | ALL: owner or admin | I,R,S,G,T |

### 2.3 Imaging — 2 tables

| Table | Purpose | Owner col | RLS (authenticated) | authenticated grants |
|---|---|---|---|---|
| `slab_images` | Slab image records (original/additional) with storage paths | owner_id, created_by | ALL: owner or admin | full |
| `image_derivatives` | Derived renditions (owner stamped by trigger from slab_images) | owner_id | ALL: owner or admin | full |

### 2.4 Pricing / valuation / PriceCharting — 11 tables

| Table | Purpose | Owner col | RLS (authenticated) | authenticated grants |
|---|---|---|---|---|
| `valuation_snapshots` | Historical valuation snapshots (captured by slabs trigger) | owner_id | ALL: owner or admin | I,R,S,G,T |
| `slab_comps` | Per-slab sold comparables (owner stamped by trigger) | owner_id | ALL: owner or admin | full |
| `sold_comps` | Marketplace sold comps, unique (source, external_sale_id) | owner_id | ALL: owner or admin | I,R,S,G,T |
| `pricecharting_products` | Cached PriceCharting product catalog | — | SELECT: true (all authed) | full (writes inert — SELECT-only policy) |
| `slab_product_candidates` | Candidate product matches per slab | owner_id | ALL: owner or admin | full |
| `slab_product_links` | Confirmed slab↔product links (confirmed/superseded) | owner_id | ALL: owner or admin | full |
| `slab_pricecharting_events` | Append-only per-slab confirmation events | owner_id, created_by | SELECT + INSERT(check): owner or admin | I,R,S,G,T (service_role: R,G,T only) |
| `pricecharting_offers` | Admin-only, token-free, buyer-PII-free offer mirror | created_by | ALL: admin | full |
| `pricecharting_offer_events` | Append-only admin audit history for offer lifecycle | — | SELECT + INSERT(check): admin | I,R,S,G,T |
| `pricecharting_marketplace_settings` | Singleton marketplace configuration | — | ALL: admin | full (anon residual R,G,T) |
| `pricecharting_sync_runs` | Marketplace sync run bookkeeping | created_by | ALL: admin | full |

### 2.5 eBay integration — 9 tables

| Table | Purpose | RLS (authenticated) | authenticated grants |
|---|---|---|---|
| `ebay_accounts` | Connected eBay seller accounts | ALL: admin | full |
| `ebay_api_runs` | eBay API call telemetry | ALL: admin | full |
| `ebay_business_policies` | Mirror of eBay business policies | ALL: admin | full |
| `ebay_inventory_locations` | Mirror of merchant inventory locations | ALL: admin | full |
| `ebay_listing_intents` | Durable listing intents driving publishes | ALL: admin | full (anon residual R,G,T) |
| `ebay_listing_mappings` | slab/SKU → offer/listing mapping + status + asking price | ALL: admin | full |
| `ebay_notifications` | Received eBay platform notifications | ALL: admin | full |
| `ebay_sync_cursors` | Per-account/resource sync cursor bookkeeping | ALL: admin | full |
| `ebay_sync_state` | Durable sync state machine (status, run_id, watermarks, totals) | SELECT: admin | R,S,G,T (anon residual R,G,T) |

### 2.6 Builder control plane (Phase 1 read-only spine, PR #80) — 7 tables

All 7: RLS `authenticated SELECT: admin`; authenticated grant **S only**; **service_role has NO DML** (R,G,T only) — writes happen only via the SECURITY DEFINER RPC `builder_append_audit_event` (audit events) or postgres/migration-side.

`builder_runs`, `builder_steps`, `builder_approvals`, `builder_tool_calls`, `builder_audit_events`, `builder_connections`, `builder_policy_rules`.

### 2.7 CGC population — 3 tables (API-unreachable today)

| Table | Purpose | RLS (authenticated) | authenticated grants |
|---|---|---|---|
| `cgc_population_cards` | Imported CGC population-report rows | SELECT: admin (**inert — no table grant**) | none |
| `cgc_population_import_runs` | Import run bookkeeping | SELECT: admin (inert) | none |
| `cgc_population_sets` | Population sets + refresh status/lock | SELECT: admin (inert) | none |

Not even `service_role` has S/I/U/D here — only postgres. The whole CGC surface is postgres-internal today (see `getCgcPopulation` operation, status BACKEND_CONTRACT_REQUIRED).

### 2.8 Quota / rate limiting (service-only by design) — 3 tables

| Table | Purpose | RLS | Access |
|---|---|---|---|
| `api_daily_usage` | Global per-bucket daily counters for paid provider calls | none (deny-all by design) | service_role R,G,T only; writes only via SECURITY DEFINER `consume_daily_quota` |
| `api_rate_limits` | Per-bucket last-reserved slot for provider pacing | none (deny-all) | service_role full |
| `api_user_daily_usage` | Per-user daily scanner/API quota counters | none (deny-all) | service_role full |

### 2.9 Accounts / admin registry — 2 tables

| Table | Purpose | Owner col | RLS (authenticated) | authenticated grants |
|---|---|---|---|---|
| `customer_profiles` | Server-managed plan/status/daily scan allowance | id (= auth.uid) | SELECT: id = uid (**no admin read policy**) | R,S,G,T |
| `slab_admins` | Admin registry table — **legacy/aux: `is_admin()` does NOT read it** (reads auth.users app metadata) | user_id | ALL: admin | full (anon residual R,G,T) |

### 2.10 Audit / ops / settings — 5 tables

| Table | Purpose | Owner col | RLS (authenticated) | authenticated grants |
|---|---|---|---|---|
| `audit_log` | Append-style audit trail (actor, action, entity, detail) | owner_id | SELECT: admin OR owner | I,R,S,G,T (INSERT inert — no INSERT policy) |
| `integration_errors` | Recorded integration failures | — | ALL: admin | full |
| `marketplace_events` | Per-slab marketplace lifecycle events | — | ALL: admin | I,R,S,G,T |
| `webhook_inbox` | Inbound webhook dedupe/storage | — | ALL: admin | I,R,S,G,T |
| `slab_settings` | Singleton admin settings incl. `allow_hard_delete` break-glass gate | — | ALL: admin | full (anon residual R,G,T) |

### 2.11 Cross-cutting facts

- **Deny-all by design:** `api_daily_usage`, `api_rate_limits`, `api_user_daily_usage` have RLS enabled and zero policies — clients cannot touch them; their table comments state this is intentional.
- **Latent TRUNCATE grants:** `authenticated` holds TRUNCATE on nearly every public table (incl. `slabs`); `anon` holds residual R/G/T on 6 tables (`ebay_listing_intents`, `ebay_sync_state`, `pricecharting_marketplace_settings`, `slab_admins`, `slab_pricecharting_events`, `slab_settings`). TRUNCATE is **not** subject to RLS. PostgREST exposes no TRUNCATE verb, so this is latent rather than remotely exploitable — flagged as a hardening-backlog revoke (see V2_SECURITY_BOUNDARIES.md §9).
- `service_role` lacks DML on the 7 builder tables, `slab_pricecharting_events`, and `api_daily_usage`; those writes flow only through SECURITY DEFINER RPCs (owner postgres) or postgres itself.
- No table uses FORCE RLS (table owner postgres bypasses — relevant only inside SECURITY DEFINER RPC bodies).

---

## 3. Private schema — 10 tables (deny-all)

All 10 are RLS-enabled with **zero policies** (deny-all). The `private` schema is not in the PostgREST search path; the only access is SECURITY DEFINER RPCs in `public` or direct service_role/postgres SQL.

| Table | Purpose | Access model (RPCs that touch it) |
|---|---|---|
| `ebay_financial_transactions` | Mirror of eBay finance transactions (fees, payouts); service-only | `ebay_finance_transactions_apply` (upsert + durable read-back count) |
| `ebay_fulfillments` | Mirror of eBay fulfillments/shipments | **No writer exists** — no RPC and no edge-function code touches it; only migrations reference it (edge fn `ebay-fulfillment` does not). Flagged. |
| `ebay_oauth_credentials` | Encrypted eBay refresh tokens + scope bookkeeping | `ebay_oauth_credential_get/_upsert/_rotate`, `ebay_credential_scopes_get/_set` (all service_role EXECUTE) |
| `ebay_oauth_states` | OAuth authorize-flow state hashes (single-use, expiring) | `ebay_oauth_state_create`, `_create_single_flight`, `_get`, `_consume` |
| `ebay_order_line_items` | Order line items incl. slab_id mapping | written by `ebay_orders_persist`; read by `ebay_sales_apply`; deleted by `purge_slabs` |
| `ebay_orders` | Orders incl. buyer data / raw payloads (**buyer PII lives here, not in public**) | `ebay_orders_persist` |
| `ebay_publish_leases` | Per (account, SKU) publish fencing leases (token + TTL) | `ebay_publish_lease_acquire/_assert_and_extend/_release` |
| `ebay_sync_leases` | Per (account, resource_type) sync fencing leases | `ebay_sync_lease_acquire/_assert_and_extend/_release`; verified inside `ebay_sync_state_load` / `ebay_sync_complete` |
| `slab_deletion_tombstones` | Immutable minimum deletion evidence for break-glass purges | written by `purge_slabs` (conflict-do-nothing = immutable); read by `get_slab_deletion_tombstone` (admin-gated) |
| `slab_storage_cleanup_queue` | Storage paths awaiting deletion after purge | enqueued by `purge_slabs`; drained via `list_pending_slab_storage_cleanup` / `acknowledge_slab_storage_cleanup` / `record_slab_storage_cleanup_failure` (admin-gated) |

Storage buckets: `slab-images` and `card-scans`, both **private** — full detail in V2_STORAGE_AUTH_MATRIX.md.

---

## 4. RPC surface — all 60 callable public functions

76 functions exist in `public`: **60 RPC-callable** (below) + 15 trigger functions + 1 event trigger (§5, internal). All auth claims come from the live function bodies (`pg_get_functiondef`), never inferred from grants. Shared primitives: `is_admin(uuid)` = `auth.users.raw_app_meta_data->>'graded_card_value_admin'` is true (does NOT consult `slab_admins`); `can_access_slab(uuid)` = slab exists AND (owner or admin). Error convention: hard failures raise SQLSTATE-coded exceptions (42501 NOT_AUTHORIZED, 22023 invalid input, P0002 not found, 23505 duplicate, 55000 busy); the eBay sync/lease family returns soft-fail jsonb instead.

| RPC | Args | Returns | EXECUTE | In-body auth | Classification | V2 operation |
|---|---|---|---|---|---|---|
| `create_slab` | p jsonb, p_front_ext, p_back_ext | `slabs` row | authenticated, postgres | auth.uid() + active profile (non-admin); duplicate-cert guard | BROWSER_CUSTOMER_SAFE | `createSlabIntake` |
| `stage_raw_card` | p jsonb | `cards` row | authenticated, postgres | auth.uid() + active profile; both paths under caller's storage folder | BROWSER_CUSTOMER_SAFE | `createRawCardIntake` |
| `check_slab_certification` | p_grader, p_cert | TABLE(id, inventory_number) | authenticated, postgres | owner-scoped filter (auth.uid()) | BROWSER_CUSTOMER_SAFE | intake pre-check (no dedicated manifest op; `createSlabIntake` surfaces DUPLICATE_CERTIFICATION) |
| `archive_slab` | p_id | `slabs` row | authenticated, postgres | can_access_slab | BROWSER_CUSTOMER_SAFE | `archiveSlab` |
| `unarchive_slab` | p_id | `slabs` row | authenticated, postgres | can_access_slab | BROWSER_CUSTOMER_SAFE | `unarchiveSlab` |
| `resolve_slab_inventory` | p_query | SETOF `slabs` | authenticated, service_role, postgres | owner-or-admin filter | BROWSER_CUSTOMER_SAFE | `listSlabs` search |
| `resolve_inventory` | p_query | TABLE(item_type, id, inventory_code, seq) | authenticated, service_role, postgres | owner-or-admin filter (slabs + cards) | BROWSER_CUSTOMER_SAFE | inventory search (`listSlabs`/`listRawCards`) |
| `link_ai_analysis_run` | p_run_id, p_slab_id | void | authenticated, postgres | can_access_slab; first-link-only | BROWSER_CUSTOMER_SAFE | intake/analysis link step (no dedicated manifest op) |
| `apply_slab_pricing` | p_slab_id, p_tiers, p_raw, p_priced_at, p_scalars? | boolean | authenticated, postgres | can_access_slab; monotonic priced_at stale guard | BROWSER_CUSTOMER_SAFE | `refreshPricing` (write half) |
| `record_pricecharting_confirmation` | p_slab_id, p_patch, p_event | void | authenticated, postgres | can_access_slab; full-overwrite patch + append-only event | BROWSER_CUSTOMER_SAFE | `confirmAnalysis` |
| `apply_pricecharting_offer_snapshot` | p_slab_id, p_snapshot, p_event_type | `pricecharting_offers` row | **service_role, postgres only** | body: admin OR service_role (grant excludes browsers) | **SECURITY_REVIEW_REQUIRED** | backend-internal (edge `pricecharting-marketplace`); V1 browser call site is dead (42501) |
| `purge_slabs` | p_ids uuid[] | TABLE(slab_id, front/back paths) | authenticated, postgres | is_admin AND `slab_settings.allow_hard_delete` AND all-ids-exist; advisory lock | DESTRUCTIVE_ADMIN_ONLY | none — excluded from the V2 provider |
| `hard_delete_slab` | p_id | TABLE(front/back paths) | authenticated, postgres | plain SQL wrapper → all gates inside `purge_slabs` | DESTRUCTIVE_ADMIN_ONLY | none — excluded from the V2 provider |
| `get_slab_deletion_tombstone` | p_slab_id | TABLE(11 evidence cols) | authenticated, postgres | is_admin | BROWSER_ADMIN_GATED | none (admin deletion-evidence viewer; not in manifest) |
| `list_pending_slab_storage_cleanup` | — | TABLE(storage_path) | authenticated, postgres | is_admin | BROWSER_ADMIN_GATED | none (cleanup queue not in manifest) |
| `acknowledge_slab_storage_cleanup` | p_paths[] | integer | authenticated, postgres | is_admin | BROWSER_ADMIN_GATED | none |
| `record_slab_storage_cleanup_failure` | p_paths[], p_error | integer | authenticated, postgres | is_admin | BROWSER_ADMIN_GATED | none |
| `reassign_slab_inventory_id` | p_slab_id, p_sequence | `slabs` row | authenticated, postgres | raises INVENTORY_ID_IMMUTABLE **unconditionally** (disabled stub) | INTERNAL_ONLY | none — permanently disabled |
| `compact_slab_inventory_ids` | — | integer | authenticated, postgres | raises unconditionally (disabled stub) | INTERNAL_ONLY | none — permanently disabled |
| `cgc_claim_import_run` | p_requested_by, p_set_id, p_mode, p_input, p_min_hours | run row | **postgres only** | is_admin(param actor) — safe only because postgres-only | INTERNAL_ONLY | none |
| `consume_daily_quota` | p_bucket, p_limit | boolean | service_role, postgres | none (grant is the gate) | EDGE_FUNCTION_ONLY | backend-internal |
| `consume_user_daily_quota` | p_user_id, p_bucket, p_hard_limit | boolean | service_role, postgres | requires active customer profile | EDGE_FUNCTION_ONLY | backend-internal |
| `reserve_api_request_slot` | p_bucket, p_min_interval_ms | timestamptz | service_role, postgres | none | EDGE_FUNCTION_ONLY | backend-internal |
| `ebay_api_run_record` | account, operation, status, http_status, request_id, latency, error_code | void | service_role, postgres | none | EDGE_FUNCTION_ONLY | backend-internal |
| `ebay_oauth_credential_get` | p_account_id | TABLE(encrypted token + scopes) | service_role, postgres | none | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_oauth_credential_upsert` | account, encrypted token, expiry, scopes, rotated_at | void | service_role, postgres | none | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_oauth_credential_rotate` | account, prior ciphertext, new ciphertext, expiry, scopes, rotated_at | integer (CAS rows) | service_role, postgres | none | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_credential_scopes_get` | p_account_id | TABLE(scope bookkeeping) | service_role, postgres | none | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_credential_scopes_set` | account, requested, reported, source | void | service_role, postgres | none | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_oauth_state_create` | state_hash, requested_by, expires_at, redirect_after | void | service_role, postgres | none | SERVICE_ROLE_ONLY | backend-internal (legacy — superseded by single_flight; no runtime caller) |
| `ebay_oauth_state_create_single_flight` | same | void | service_role, postgres | none; one live flow per user (advisory lock) | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_oauth_state_get` | p_state_hash | TABLE(state row) | service_role, postgres | none | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_oauth_state_consume` | p_state_hash | void | service_role, postgres | none; single-use | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_business_policies_replace` | p_account_id, p_policies jsonb | jsonb (confirmed post-write counts) | service_role, postgres | none | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_inventory_locations_replace` | p_account_id, p_locations jsonb | integer (confirmed count) | service_role, postgres | none | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_orders_persist` | p_account_id, p_orders jsonb | jsonb (confirmed durable totals) | service_role, postgres | none | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_finance_transactions_apply` | p_account_id, p_transactions jsonb | jsonb (durable total) | service_role, postgres | none | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_sales_apply` | p_account_id, p_sales jsonb | jsonb {applied, skipped_stale, skipped_unmatched} | service_role, postgres | none; stale-rejects mismatched slab mappings; **no slab ownership check** (service-trusted) | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_publish_lease_acquire` | account, sku, token, ttl | jsonb {acquired[, token]} | service_role, postgres | none; soft-fail on foreign live lease | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_publish_lease_assert_and_extend` | account, sku, token, ttl | jsonb {held} | service_role, postgres | exact-token fencing | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_publish_lease_release` | account, sku, token | jsonb {released} | service_role, postgres | exact-token fencing | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_sync_lease_acquire` | account, resource_type, token, ttl | jsonb {acquired} | service_role, postgres | none; soft-fail | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_sync_lease_assert_and_extend` | account, resource_type, token, ttl | jsonb {held} | service_role, postgres | exact-token fencing | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_sync_lease_release` | account, resource_type, token | jsonb {released} | service_role, postgres | exact-token fencing | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_sync_state_load` | account, resource_type, lease_token | jsonb {ok, run_id, high_watermark_at} | service_role, postgres | live-lease check (`lease_lost` soft error) | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_sync_complete` | account, resource_type, run_id, lease_token, watermarks, totals, latency | jsonb {ok} | service_role, postgres | double fence: lease token AND run_id (`lease_lost`/`stale_runner`) | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_sync_state_fail` | account, resource_type, run_id, error_code | jsonb {ok} | service_role, postgres | run_id fence | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_sync_cursor_touch` | account, resource_type, count | void | service_role, postgres | none; last-write-wins | SERVICE_ROLE_ONLY | backend-internal |
| `ebay_listing_reconcile_local` | 15 args (ids, offer/listing state, expected snapshot) | jsonb {ok, offer_id, listing_id} / soft-fail codes | service_role, postgres | optimistic-concurrency fence (fingerprint/version/status/updated_at) | SERVICE_ROLE_ONLY | backend-internal |
| `builder_append_audit_event` | run_id, actor, event_type, detail, correlation_id | uuid | service_role, postgres | none; append-only | SERVICE_ROLE_ONLY | backend-internal (no runtime caller yet — Phase 1) |
| `reconcile_stale_exact_api_tier` | — | integer (rows demoted) | service_role, postgres (NOT SECURITY DEFINER) | none | SERVICE_ROLE_ONLY | backend-internal (manual maintenance; no runtime caller) |
| `is_admin` | _user_id uuid | boolean | authenticated, service_role, postgres | none — reads app_metadata flag | BROWSER_CUSTOMER_SAFE | session role probe (`getSession` adapter) |
| `can_access_slab` | p_slab_id | boolean | authenticated, service_role | owner-or-admin predicate | INTERNAL_ONLY | none (helper used by other RPCs) |
| `slab_owner` | p_slab_id | uuid | authenticated (via default) | none — returns owner of any slab id | INTERNAL_ONLY | none (RLS/storage helper) |
| `slab_object_owner` | p_name text | uuid | authenticated (via default) | none — maps `slabs/<n>/…` path → owner | INTERNAL_ONLY | none (storage policy helper) |
| `normalize_cert` | p text | text | anon, authenticated, PUBLIC | pure IMMUTABLE normalizer | BROWSER_CUSTOMER_SAFE | client normalization parity |
| `normalize_grader` | p text | text | anon, authenticated, PUBLIC | pure IMMUTABLE normalizer | BROWSER_CUSTOMER_SAFE | client normalization parity |
| `valid_image_ext` | p_ext text | text | authenticated, PUBLIC | pure IMMUTABLE validator (22023 on bad ext) | BROWSER_CUSTOMER_SAFE | upload validation parity |
| `parse_inventory_code` | p_query text | TABLE(prefix, sequence) | authenticated, service_role | pure IMMUTABLE parser | BROWSER_CUSTOMER_SAFE | search parsing parity |
| `pricecharting_game_url` | p_console, p_name | text | PUBLIC (default ACL) | pure IMMUTABLE slug builder | BROWSER_CUSTOMER_SAFE | URL building parity |

---

## 5. Internal (non-RPC) functions — 15 trigger functions + 1 event trigger

Not invokable via PostgREST (`RETURNS trigger`/`event_trigger`). Listed as INTERNAL for completeness:

| Function | Attached to | Purpose |
|---|---|---|
| `assign_raw_card_inventory` | cards | Assign R-prefix inventory sequence on insert |
| `capture_confirmed_product_link` | slabs | Seed pricecharting_products, supersede old links, insert slab_product_links |
| `capture_pricecharting_sold_comp` | pricecharting_offers | Auto-insert sold_comps when an offer turns sold |
| `capture_slab_valuation_snapshot` | slabs | Snapshot valuation state when pricecharting_priced_at advances |
| `create_customer_profile` | auth.users | Auto-create customer_profiles row for new users (SECURITY DEFINER) |
| `derive_slab_identity_fields` | slabs | Infer game_or_franchise / finish from label text |
| `enforce_inventory_id_immutable` | slabs, cards | Block inventory id changes unless GUC `app.inventory_maintenance='on'` (postgres-only escape hatch) |
| `normalize_slab_enum_inputs` | slabs | Lowercase inventory_status; remap legacy candidate_image_type |
| `set_child_owner_from_slab` | 9 child tables | Stamp owner_id from parent slab (SECURITY DEFINER) |
| `set_derivative_owner_from_image` | image_derivatives | Stamp owner_id from parent slab_images row |
| `set_pricecharting_canonical_url` | pricecharting_products | Default canonical_url |
| `set_slab_acquired_from_original_image` | slab_images | Backfill slabs.acquired_at from original image date |
| `slab_set_updated_at` | slabs, cgc_population_cards/sets | updated_at maintenance |
| `sync_source_statuses` | slabs | Map visual_confirmation_status → visual_identity_status; pin cert verification to not_checked |
| `sync_visual_valuation_confidence` | slabs | Derive valuation_confidence from provenance + confirmation |
| `rls_auto_enable` (event trigger) | CREATE TABLE in public | Auto-enable RLS on new tables (SECURITY DEFINER) |

---

## 6. Operation contracts — the 31 frontend operations

From `contracts/backend-operations.ts` (`OPERATIONS`, `CONTRACT_VERSION = "1.0.0-ba3953fd-m65"`). Every provider method returns `BackendResult<T> = { ok: true; data: T } | { ok: false; error: BackendError }` with errors from `contracts/error-codes.ts`. Named request/response interfaces are declared in `backend-operations.ts`; inline shapes below are descriptive (adapter-defined), marked "(adapter)".

| # | Operation | Domain | Role | Request type | Response type | Backend resources | Classification | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | `getSession` | auth | anon | — | `SessionInfo \| null` | auth:gotrue | BROWSER_CUSTOMER_SAFE | READY |
| 2 | `signIn` | auth | anon | `SignInRequest` | `SessionInfo` | auth:gotrue | BROWSER_CUSTOMER_SAFE | READY |
| 3 | `signOut` | auth | customer | — | void | auth:gotrue | BROWSER_CUSTOMER_SAFE | READY |
| 4 | `getCurrentProfile` | profile | customer | — | `CustomerProfileRow` | table:customer_profiles | BROWSER_CUSTOMER_SAFE | READY |
| 5 | `getDashboardSummary` | dashboard | customer | — | summary aggregate (adapter) | table:slabs, table:cards, table:valuation_snapshots | BROWSER_CUSTOMER_SAFE | ADAPTER_REQUIRED |
| 6 | `listSlabs` | inventory | customer | `ListSlabsRequest` | `SlabRow[]` | table:slabs | BROWSER_CUSTOMER_SAFE | READY |
| 7 | `getSlab` | inventory | customer | {slabId} (adapter) | `SlabRow` + signed image URLs (adapter) | table:slabs, table:slab_images, storage:slab-images | BROWSER_CUSTOMER_SAFE | READY |
| 8 | `listRawCards` | inventory | customer | query (adapter) | `CardRow[]` | table:cards | BROWSER_CUSTOMER_SAFE | READY |
| 9 | `getRawCard` | inventory | customer | {cardId} (adapter) | `CardRow` + signed URLs (adapter) | table:cards, table:card_scans, storage:card-scans | BROWSER_CUSTOMER_SAFE | READY |
| 10 | `archiveSlab` | inventory | customer | {slabId} (adapter) | `SlabRow` | rpc:archive_slab | BROWSER_CUSTOMER_SAFE | READY |
| 11 | `unarchiveSlab` | inventory | customer | {slabId} (adapter) | `SlabRow` | rpc:unarchive_slab | BROWSER_CUSTOMER_SAFE | READY |
| 12 | `createSlabIntake` | intake | customer | `CreateSlabIntakeRequest` | `SlabRow` | rpc:create_slab | BROWSER_CUSTOMER_SAFE | READY |
| 13 | `createRawCardIntake` | intake | customer | raw intake fields (adapter) | `CardRow` | rpc:stage_raw_card | BROWSER_CUSTOMER_SAFE | READY |
| 14 | `uploadSlabImage` | intake | customer | `UploadSlabImageRequest` | void | storage:slab-images, table:slab_images | BROWSER_CUSTOMER_SAFE | ADAPTER_REQUIRED |
| 15 | `startSlabAnalysis` | analysis | customer | `StartSlabAnalysisRequest` | `AnalysisResult` | edge:scan-card | BROWSER_CUSTOMER_SAFE | READY |
| 16 | `getAnalysis` | analysis | customer | {runId} (adapter) | `AnalysisResult` | table:ai_analysis_runs, table:ai_field_evidence | BROWSER_CUSTOMER_SAFE | READY |
| 17 | `confirmAnalysis` | analysis | customer | `ConfirmAnalysisRequest` | void | rpc:record_pricecharting_confirmation | BROWSER_CUSTOMER_SAFE | READY |
| 18 | `correctAnalysis` | analysis | customer | `CorrectAnalysisRequest` | `SlabRow` | table:slabs (direct RLS update today) | **SECURITY_REVIEW_REQUIRED** | BACKEND_CONTRACT_REQUIRED |
| 19 | `getPricingEvidence` | pricing | customer | {slabId} (adapter) | `PricingEvidence` | table:valuation_snapshots, table:slab_product_links, table:slab_product_candidates, table:slab_pricecharting_events | BROWSER_CUSTOMER_SAFE | ADAPTER_REQUIRED |
| 20 | `refreshPricing` | pricing | admin | {slabId} (adapter) | applied result (adapter) | edge:pricecharting-search, rpc:apply_slab_pricing | BROWSER_ADMIN_GATED | ADAPTER_REQUIRED |
| 21 | `listSoldComparables` | pricing | customer | {slabId?} (adapter) | `SoldCompRow[]` + `SlabCompRow[]` (adapter) | table:sold_comps, table:slab_comps | BROWSER_CUSTOMER_SAFE | READY |
| 22 | `getCgcPopulation` | population | customer | query (adapter) | — (unusable today) | table:cgc_population_cards, table:cgc_population_sets | **SECURITY_REVIEW_REQUIRED** | BACKEND_CONTRACT_REQUIRED |
| 23 | `listActivity` | activity | customer | query (adapter) | `AuditLogRow[]` | table:audit_log | BROWSER_CUSTOMER_SAFE | READY |
| 24 | `getAdminReviewQueue` | admin | admin | — | `CardScanReviewRow[]` | table:card_scan_reviews, table:card_scans | BROWSER_ADMIN_GATED | READY |
| 25 | `resolveAdminReview` | admin | admin | {reviewId, resolution} (adapter) | `CardScanReviewRow` | table:card_scan_reviews | BROWSER_ADMIN_GATED | ADAPTER_REQUIRED |
| 26 | `getMarketplaceState` | marketplace | admin | — | `MarketplaceState` | table:pricecharting_marketplace_settings, table:pricecharting_offers, table:pricecharting_sync_runs | BROWSER_ADMIN_GATED | READY |
| 27 | `connectEbayAccount` | ebay | admin | {redirectAfter} (adapter) | OAuth redirect handoff (adapter) | edge:ebay-oauth-start, edge:ebay-oauth-callback | BROWSER_ADMIN_GATED | READY |
| 28 | `listEbayListings` | ebay | admin | — | `EbayListingIntentRow[]` + mappings (adapter) | table:ebay_listing_intents, table:ebay_listing_mappings | BROWSER_ADMIN_GATED | READY |
| 29 | `listEbayOrders` | ebay | admin | — | — (no reader exists) | private:ebay_orders, private:ebay_order_line_items | **SECURITY_REVIEW_REQUIRED** | BACKEND_CONTRACT_REQUIRED |
| 30 | `getBuilderRuns` | builder | admin | — | `BuilderRunRow[]` | 5 builder tables (runs, steps, approvals, tool_calls, audit_events) | BROWSER_ADMIN_GATED | READY |
| 31 | `getSubscriptionState` | profile | customer | — | — (static placeholder) | (none — no billing backend exists) | **SECURITY_REVIEW_REQUIRED** | DEFERRED |

Status distribution: 20 READY · 6 ADAPTER_REQUIRED · 3 BACKEND_CONTRACT_REQUIRED · 1 DEFERRED · (SECURITY_REVIEW_REQUIRED is a classification, carried by 4 of the above). Manifest invariants: no operation references `purge_slabs`, `hard_delete_slab`, the cleanup-queue trio, `slab_settings`, or any SERVICE_ROLE_ONLY / EDGE_FUNCTION_ONLY RPC — those surfaces are deliberately outside the V2 provider (see V2_SECURITY_BOUNDARIES.md).

---
## Addendum — contract v1.1.0 amendment (2026-07-27)
The operation manifest was amended from 31 to 35 operations after this document's body was authored: `signUp`, `requestPasswordReset`, and `updatePassword` were added (READY, auth:gotrue — covering /sign-up, /forgot-password, /account/security), and `getAdminUsers` was added (BACKEND_CONTRACT_REQUIRED — /admin/users has no backing today; see V2_INTEGRATION_GAPS G4). Operation counts in the body predate the amendment; `contracts/backend-capabilities.json` (v1.1.0) is canonical.
