# Deep Audit + Stress Test — Graded Card Value backend / connectors

**Date:** 2026-07-29
**Scope:** production `rcbwemkfcefarqnlgrmv` + staging `msbdwwgojuvgnuugrrry`, backend `72e6e58`.
**Verdict:** No CRITICAL / HIGH / ERROR findings on either project. Every WARN-level
advisor was individually inspected and verified benign (by design), by reading the
object definitions AND by live probes with disposable customer JWTs.

---

## 1. Security advisors — prod + staging (identical result)

`get_advisors(security)` on both projects: **0 ERROR, 0 CRITICAL, 0 HIGH.**

Findings, all intentional:

### 1a. INFO `rls_enabled_no_policy`
- `private.*` tables (`ebay_*`, `slab_deletion_tombstones`, `slab_storage_cleanup_queue`):
  the `private` schema is **not** exposed through PostgREST, so "RLS on, no policy" is a
  deny-all to every client role. Only SECURITY DEFINER functions / service role reach them.
- `public.api_daily_usage`, `public.api_rate_limits`, `public.api_user_daily_usage`:
  RLS enabled + no policy = deny-all to `anon`/`authenticated`. These are counters written
  only by edge functions (service role). Correct fail-closed posture.

### 1b. WARN `authenticated_security_definer_function_executable` (~26 functions)
This lint flags every SECURITY DEFINER function that `authenticated` may call via
`/rest/v1/rpc/*`. That is the application's RPC surface **by design** — the EXECUTE grant is
required for the app to work, and authorization is enforced *inside* each function. The
destructive / global / cross-tenant-sensitive ones were read in full and confirmed guarded:

| Function | Internal guard | Extra defense |
|---|---|---|
| `purge_slabs(uuid[])` | `is_admin()` → NOT_AUTHORIZED | global `allow_hard_delete` kill-switch (default OFF); tombstone + audit_log; advisory lock |
| `compact_slab_inventory_ids()` | `is_admin()` | defused no-op (always raises INVENTORY_ID_IMMUTABLE) |
| `reassign_slab_inventory_id(uuid,int)` | `is_admin()` | defused no-op |
| `acknowledge_slab_storage_cleanup(text[])` | `is_admin()` | — |
| `list_pending_slab_storage_cleanup()` | `is_admin()` | — |
| `record_slab_storage_cleanup_failure(text[],text)` | `is_admin()` | — |
| `apply_slab_pricing(uuid,…)` | `can_access_slab()` (owner/admin) | monotonic `priced_at` guard |
| `link_ai_analysis_run(uuid,uuid)` | `can_access_slab()` | only links runs where `slab_id IS NULL` (no steal) |
| `resolve_inventory(text)` | row filter `owner_id = auth.uid() OR is_admin()` | — |
| `resolve_slab_inventory(text)` | row filter `owner_id = auth.uid() OR is_admin()` | — |

All have `SET search_path` pinned (no search_path-injection surface). The owner-scoped CRUD
functions (`create_slab`, `archive_slab`, `unarchive_slab`, `save_confirmed_slab_from_analysis`,
`correct_slab_identification`, `stage_raw_card`, `record_pricecharting_confirmation`,
`can_access_slab`, `slab_owner`, `is_admin`, …) were confirmed guarded in prior passes.

**Live proof (fresh customer JWT, prod, direct RPC — bypassing the frontend):**
```
POST /rest/v1/rpc/purge_slabs                    -> 403 {"code":"42501","message":"NOT_AUTHORIZED"}
POST /rest/v1/rpc/compact_slab_inventory_ids     -> 403 42501 NOT_AUTHORIZED
POST /rest/v1/rpc/reassign_slab_inventory_id     -> 403 42501 NOT_AUTHORIZED
POST /rest/v1/rpc/list_pending_slab_storage_cleanup -> 403 42501 NOT_AUTHORIZED
POST /rest/v1/rpc/acknowledge_slab_storage_cleanup  -> 403 42501 NOT_AUTHORIZED
POST /rest/v1/rpc/resolve_slab_inventory         -> 200 []   (no cross-tenant rows)
```

### 1c. WARN `auth_leaked_password_protection` disabled
HaveIBeenPwned check is off. **Owner dashboard toggle** (Auth → Policies). Recommended, not
a blocker. Documented for owner.

---

## 2. Performance advisors — prod

`get_advisors(performance)`: **0 ERROR / 0 CRITICAL.**
- 1 WARN `multiple_permissive_policies` on `public.slabs` (role `authenticated`, action SELECT):
  two permissive policies `slabs_admin_select` + `slabs_owner_select`. By design (owner sees own
  rows; admin sees all). Optional micro-optimization: merge into one policy
  `USING (owner_id = auth.uid() OR is_admin(auth.uid()))`. **Not changed** — altering RLS on the
  most sensitive live table for a cosmetic perf lint is out of scope for this release.
- INFO `unindexed_foreign_keys` (~28) on low-traffic admin/audit/builder/ebay tables — covering
  indexes are a future optimization, no correctness impact.
- INFO `unused_index` (7) on newly-created tables (builder_*, ebay_listing_intents, …) with no
  traffic yet — expected.
- INFO `auth_db_connections_absolute` — Auth uses a fixed 10-connection pool; percentage-based
  allocation is a scale-tuning suggestion. Owner note.

---

## 3. Edge-function configuration audit (18 functions)

Every **user-facing** function enforces `verify_jwt: true`, including the release-critical
`analyze-slab`. The only two `verify_jwt: false` functions are inbound webhooks that
architecturally cannot carry a user JWT and validate via state / verification-token instead:

- `ebay-oauth-callback` — OAuth redirect target (validates `state`).
- `ebay-notification-handler` — eBay marketplace notification/deletion webhook (validates token).

Both are **dormant** (eBay is unconfigured/disabled this release), so no live exposure. All 14
eBay operational functions + `pricecharting-*` + `scan-card` + `market-intelligence` +
`marketplace-scheduler` are `verify_jwt: true`.

**`analyze-slab`: live version 88, `verify_jwt: true`.** ezbr_sha256
`14c4d158…069d4` is **byte-identical** to the recorded deploy-time v87 → the deployed code is
unchanged; v88 is a config-only version bump. Behaviour re-confirmed live in §4.

---

## 4. Concurrency stress test — `analyze-slab` (auth + validation path)

Chosen because it is the release-critical function and its auth/validation stages complete
**before** any OpenAI call, so the test carries zero provider cost. Two 40-way concurrent
bursts against prod:

| Burst | n | Result |
|---|---|---|
| No `Authorization` header | 40 | **40 × HTTP 401** (platform verify_jwt held under load) |
| Authenticated, empty body `{}` | 40 | **40 × HTTP 400** MISSING_IMAGE (validation held; no 5xx) |

- **Zero** 5xx / connection failures across all 80 concurrent requests.
- Latency max 3.95s / avg 3.02s reflects Edge cold-start warming across a simultaneous burst,
  not error — codes were uniformly correct.
- The authed `{}` → 400 MISSING_IMAGE result also proves the **customer path is live**: a
  brand-new customer passes JWT verification **and** the `ANALYZE_SLAB_CUSTOMER_ENABLED` +
  authorization gate, reaching image validation (a disabled flag would yield 403
  CUSTOMER_ACCESS_DISABLED). The rollout flag is demonstrably still `true`.

---

## 5. Data-integrity boundary (confirmed in prior pass, unchanged)

- No SECURITY DEFINER function lacks a pinned `search_path`.
- No `anon`-readable RLS-disabled table in `public`.
- `authenticated` has **SELECT-only** on `slabs`; INSERT/UPDATE/DELETE denied (RLS + grants);
  writes flow exclusively through guarded SECURITY DEFINER RPCs.
- `ai_analysis_runs` / `ai_field_evidence` / `valuation_snapshots` have owner-scoped
  `WITH CHECK` INSERT policies; `audit_log` has **no** INSERT policy (RLS denies client inserts →
  audit integrity holds; only SECURITY DEFINER paths write it).

---

## Method / hygiene

Live checks used disposable `@example.com` accounts created via public signup, exercised, and
**deleted immediately after** (0 residual test users; verified by `DELETE … RETURNING`).
No secrets, passwords, or tokens are recorded in this file or in git.

## Owner-actionable (non-blocking) follow-ups
1. Enable leaked-password protection (Auth dashboard toggle).
2. (Optional) Merge the two `slabs` SELECT policies to clear the perf WARN.
3. (Optional, low priority) Add covering indexes for the INFO-listed foreign keys if those
   admin/audit tables grow.
