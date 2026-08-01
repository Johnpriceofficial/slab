# 00 — Source of truth (Phase 0, read-only)

Reverified live on 2026-08-01. **No system was modified in Phase 0.** Every ID/SHA
below was read back from the authoritative platform, not assumed from the brief.

## GitHub

| Item | Value | Verified |
| --- | --- | --- |
| Frontend repo | `Johnpriceofficial/slab-scribe-pro` | ✅ |
| Frontend `main` | `eadeedf98ae165ec7cb98d87a9b79a314bd58c95` | ✅ tip |
| Frontend merge commit | `eadeedf9` = "Merge PR #8: reconcile Lovable remediation into main" (2026-08-01T17:19:10Z) | ✅ |
| Frontend `main` CI | **14/14 checks success** (Release gate, Contract drift, Route inventory, Dependency audit, Secret scan, Whatnot manifest, Lockfile, Backend contract freshness, Typecheck, Playwright access-control, Format, Lint, Production build, Unit tests+coverage) | ✅ |
| Frontend branch protection | **OFF** (`protected:false`) — gap to close in Phase 12 | ⚠ |
| Frontend open PRs | none | ✅ |
| Backend repo | `Johnpriceofficial/slab` | ✅ |
| Backend `main` | `c65d438805a03e7c555a32337631b114b2e7ca69` | ✅ tip |
| Backend branch protection | **ON** (`protected:true`) | ✅ |

### Open backend PRs

| PR | Head | State | Migration introduced | Notes |
| --- | --- | --- | --- | --- |
| #97 | `e42dc5a` | draft, CLEAN | — (evidence only) | migration-chain + reconciliation evidence; **keep open, do not merge** |
| #96 | `1c79896` | draft, CLEAN | `20260911000000_supporting_fk_indexes.sql` | G6 covering indexes |
| #95 | `b78df18` | draft, BLOCKED | `20260910000000_admin_authority_unification.sql` | F5+G4 admin authority under `user_roles` |
| #94 | `9f3a992` | draft, BLOCKED | `20260909000000_least_privilege_authz_tables.sql` | least-privilege grants |
| #79 | `a1cda98` | draft, BEHIND | — | **out of scope** (older) |
| #41 | `61af11c` | open, BEHIND | — | **out of scope** (older) |
| #40 | `cbef2d7` | open, **CONFLICTING** | — | **out of scope**; dirty |

**Canonical migration sequence after `main` (tip `20260908`)** is therefore:
`20260909` (#94) → `20260910` (#95) → `20260911` (#96). New Phase-4 canonical
migrations must start at **`20260912000000`** to avoid a timestamp collision.

## Supabase

| Item | Value | Verified |
| --- | --- | --- |
| Production project | `rcbwemkfcefarqnlgrmv` — "Johnpriceofficial's Project", org `fjfcjjyocmbipetyyzdp`, region us-west-2, PG 17.6, **ACTIVE_HEALTHY** | ✅ |
| Production ledger tip | `20260904000000_slab_deletion_tombstones_rls` (69 rows; out-of-band `20260729131106`/`131134`) | ✅ |
| Staging project | `msbdwwgojuvgnuugrrry` — branch `9665d6c8`, parent = prod, **FUNCTIONS_DEPLOYED**, created 2026-07-29, **no customer data** | ✅ |
| Staging ledger tip | `20260904000000` + 5 `canonical_2026090x` rehearsal rows + `phase_2a_*` | ✅ |
| Prod default control-plane branch | `b317ade1` — **`MIGRATIONS_FAILED`** ⚠ (see defect D-1) | ⚠ |
| Extra branch (out of scope) | `v2-integration` = `bunjmritgcwmwrrjzpvy`, FUNCTIONS_DEPLOYED | ℹ |
| Prod Edge Functions | 19 ACTIVE — `analyze-slab` v88, `scan-card` v65, `pricecharting-search` v99, `pricecharting-marketplace`/`-sync` v61, `marketplace-scheduler` v19, `ebay-*` v61 (16 fns), `market-intelligence` v15 | ✅ |

### Production function/authority state (read-only, reverified)

| Object | Prod normalized body md5 | Canonical md5 | Equal? |
| --- | --- | --- | --- |
| `link_ai_analysis_run` | `fecac022…` | `cea8c9ef…` | ❌ drift |
| `list_pending_slab_storage_cleanup` | `ee13223d…` | `fc3218f8…` | ❌ drift |
| `purge_customer_account_data` | **absent** | `136365bc…` | ❌ missing |
| `save_confirmed_slab_from_analysis` | `c5265afe…` | `53652291…` | ❌ drift |
| `correct_slab_identification` | `b38bf027…` | `b38bf027…` | ✅ |
| `forbid_direct_slab_delete` | `0db91967…` | `0db91967…` | ✅ |
| `guard_slab_protected_columns` | `90cb13a8…` | `90cb13a8…` | ✅ |

Admin authority in prod is **split**: `has_role` + `user_roles` + `app_role`
(out-of-band) coexist with `is_admin` (app-metadata). PR #95 unifies this.

### Staging function state (read-only, reverified) — already reconciled

7/7 targets byte-match canonical (`link=cea8c9ef`, `list_pending=fc3218f8`,
`purge=136365bc` present, `save_confirmed=53652291`, `correct=b38bf027`,
`forbid=0db91967`, `guard=90cb13a8`). **Staging must NOT be re-migrated** for
`20260905`–`20260908`; the rehearsal (PR #97) already applied them.

## Vercel

| Item | Value | Verified |
| --- | --- | --- |
| Team | JOHN PRICE = `team_Aa6u5Idjikkysa6Y2mB8FOgE` | ✅ |
| Existing project | `slab-13rc` = `prj_s3HNK69VRTNimpNMQnxxP9JyA575` (vite, Node 24.x, backend-repo shadow) | ✅ |
| `slab-13rc` domains | `slab-13rc.vercel.app` + git/team aliases only — **no custom domain** | ✅ |
| `slab-13rc` latest deploy | `dpl_5WqesHBNZdH14tgKQLVkfAfJcB6q`, `target:null` (not production-promoted) | ✅ |
| Project importing `slab-scribe-pro` | **none exists** → Phase 2 required (owner dashboard action; see `01-vercel-staging-creation.md`) | ✅ |
| `gradedcardvalue.com` on Vercel | **absent** — production still served via Cloudflare surface | ✅ |

## Lovable

| Item | Value | Source |
| --- | --- | --- |
| Project id | `d3c023a7-ef76-49d3-83ec-29074c6d035e` | owner brief |
| Local export template | `tanstack_start_ts_current` rev `…e6c04607f4f7` | `.lovable/project.json` |
| Canonical rule | GitHub `slab-scribe-pro/main` is canonical; Lovable is design/preview only | locked architecture |
| Published state / Lovable-Cloud DB provisioning | **not inspectable** without the Lovable API (no MCP connector in this session) — **owner-gated read** | — |

## Frontend build stack (Vercel-readiness)

`@tanstack/react-start` + `@tanstack/react-router` + `nitro@3.0.x-beta` +
`@lovable.dev/vite-tanstack-config@2.8.2` + `vite@8`. `vite build` emits a Nitro
`.output` tree; with `VERCEL=1` Nitro selects the Vercel Build Output API preset.
There is a **server runtime** (`/api/public/contact`, eBay server calls), so
`EBAY_*` and `LOVABLE_API_KEY` are **server-side** env (never `VITE_`).

### Authoritative browser env contract (from `.env.example`, overrides brief's guessed names)

- `VITE_BACKEND_MODE` ∈ {`mock`,`staging`,`production`} — unset/unknown/`mock`
  fails **closed** in published builds ("Portal configuration incomplete").
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (publishable/anon **only**,
  service-role rejected by the config guard), `VITE_EXPECTED_SUPABASE_PROJECT_REF`
  — pinned: staging→`msbdwwgojuvgnuugrrry`, production→`rcbwemkfcefarqnlgrmv`.
- `VITE_ANALYZE_SLAB_ENABLED` — staging-only gate; can never enable production.

## Confirmed defects (reported immediately)

- **D-1 (control-plane, P1-for-Gate-A):** production Supabase default branch
  `b317ade1` reports **`MIGRATIONS_FAILED`** while the project itself is
  `ACTIVE_HEALTHY` and answers read queries. Not dismissed: the DB is healthy and
  serving, ledger tip is `20260904`, and the repo declares `20260905`–`20260911`
  not yet in prod plus out-of-band `20260729131106/131134`. The failed state
  reflects the **unreconciled production ledger**; resolving it is part of the
  Gate-A production promotion, not a staging-phase action.
- **D-2 (frontend governance, Phase 12):** `slab-scribe-pro/main` has **no branch
  protection**.
- **D-3 (hygiene):** out-of-scope PR #40 is CONFLICTING; #41/#79 are BEHIND.

## Phase-4 canonicalization delta (frontend `backend-patches/` → `slab`)

| Patch | Objects | In `slab`? | In staging? | In prod? | Action |
| --- | --- | --- | --- | --- | --- |
| `20260731-grading-advisor` | 15 tables (catalog + advice) + `grading_advisor_usage` + `consume_grading_advice_quota` | ❌ | ❌ | ❌ | **PORT** → `20260912` |
| `rate-limit-atomic` | `try_rate_limit_consume` + `rate_limit_hits` | ❌ (slab uses `api_rate_limits`) | ❌ | ❌ | **RECONCILE** — verify FE call sites before porting |
| `20260730-ebay-oauth-token-storage` | `ebay_oauth_tokens`/`ebay_oauth_states` | verify | verify | verify | reconcile vs prod eBay tables |
| `20260730-ebay-authorized-at` | `ebay_oauth_tokens.authorized_at` | verify | — | — | reconcile |
| `20260730-ebay-deletion-token` | `ebay_deletion_endpoint_settings` | verify | — | — | reconcile |
| `20260729-user-roles-foundation` | `app_role`/`user_roles`/`has_role` | via PR #95 | phase_2a | out-of-band | **PR #95** owns this |
| `20260730-account-foundation` | `customer_profiles`/`account_preferences` | verify vs `20260802` | — | — | reconcile |
| `20260907-atomic-confirmed-save` | `save_confirmed_slab_from_analysis` | ✅ `20260907` | ✅ | drift | already canonical |
| `20260929-slab-permission-model` | slab permission model | ✅ `20260908` | ✅ | ✅ | already canonical |
