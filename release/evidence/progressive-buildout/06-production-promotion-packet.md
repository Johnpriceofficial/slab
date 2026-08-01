# 06 — Production promotion packet (Gate A)

**STOP. This is the pre-production-write gate. Nothing below has been applied to
production.** Owner approval required before any Phase-8 action.

## Exact commits
| Artifact | Commit |
| --- | --- |
| Backend integration branch (this PR #98) | `release/backend-production-completion` @ push head (foundation + grading + rate-limit) |
| Backend canonical base | `slab@c65d438` |
| Remediation PRs | #94 `9f3a992` · #95 `b78df18` · #96 `1c79896` |
| Frontend | `slab-scribe-pro@eadeedf98ae165ec7cb98d87a9b79a314bd58c95` |

## Exact migrations to apply to production (in order)
Production ledger tip is `20260904`. Apply the **repo files** (never ad-hoc SQL):

| # | Migration | Prod action | Why |
| --- | --- | --- | --- |
| 1 | `20260905000000_analyze_slab_link_hardening` | **APPLY** | prod `link_ai_analysis_run` drifted (`fecac022`→`cea8c9ef`) |
| 2 | `20260906000000_account_deletion` | **APPLY** | `purge_customer_account_data` **absent** in prod |
| 3 | `20260907000000_save_confirmed_slab_from_analysis` | **APPLY** | prod drifted (`c5265afe`→`53652291`) |
| 4 | `20260908000000_slab_permission_model` | **LEDGER-REPAIR** | prod already has `correct`/`forbid`/`guard` canonical (byte-match) — confirm equivalence, mark applied |
| 5 | `20260908500000_authority_foundation` | **LEDGER-REPAIR** | prod already has `app_role`(labels ✓)/`user_roles`/`has_role` out-of-band; migration is idempotent — confirm equivalence, mark applied |
| 6 | `20260909000000_least_privilege_authz_tables` (#94) | **APPLY** | idempotent REVOKEs; `user_roles`+`slab_admins` present in prod |
| 7 | `20260910000000_admin_authority_unification` (#95) | **APPLY** | repoints `is_admin`→`user_roles`; see admin impact below |
| 8 | `20260911000000_supporting_fk_indexes` (#96) | **APPLY** | indexes; prefer CONCURRENTLY where blocking is inappropriate |
| 9 | `20260912000000_grading_advisor` | **APPLY** | new tables; only `auth.users` dep |
| 10 | `20260913000000_atomic_rate_limit_consume` | **APPLY** | new `rate_limit_hits`+`try_rate_limit_consume` |

> `20260906` must be **executed** (purge is genuinely absent) — never marked
> applied while `purge_customer_account_data` is missing.

## Ledger-repair plan (out-of-band → canonical)
Prod carries out-of-band `20260729131106` (save_confirmed) and `20260729131134`
(slab_permission_model), plus out-of-band authority objects. After applying the
functions above, `supabase migration repair` maps the out-of-band ids to their
canonical equivalents **only after byte-equivalence is confirmed** (method +
mapping in `release/evidence/frontend-backend-finalization/migration-ledger-reconciliation.md`).
This is what clears **D-1 (`MIGRATIONS_FAILED`)**.

## Production before-state hashes (read-only, reverified)
`link=fecac022` · `list_pending=ee13223d` · `purge=ABSENT` · `save_confirmed=c5265afe`
· `correct=b38bf027`✓ · `forbid=0db91967`✓ · `guard=90cb13a8`✓ · ledger tip `20260904`.

## Staging after-state hashes (target; byte-match canonical)
`link=cea8c9ef` · `list_pending=fc3218f8` · `purge=136365bc` · `save_confirmed=53652291`
· `correct=b38bf027` · `forbid=0db91967` · `guard=90cb13a8`. (7/7 — PR #97.)

## Migration dry-run output (disposable PostgreSQL)
75-migration integrated chain (canonical 69 + foundation + #94 + #95 + #96 +
grading + rate-limit) applied **clean from zero, 0 manual interventions**;
`SCHEMA ASSERTIONS PASS`; `GRADING VERIFY PASS`; `RATE-LIMIT VERIFY PASS` (`03`).

## Administrator migration impact (#95) — reverified in prod, read-only
| Metric | Value |
| --- | --- |
| app_metadata admins | 2 |
| in `user_roles('administrator')` | 1 |
| in `slab_admins` | 1 |
| **`unexpected` (gate abort trigger)** | **0** ✅ |
| `app_role` labels present | `administrator, customer, admin` ✅ |

⇒ #95's consistency gate **passes** (0 unexpected); backfill from `slab_admins`
yields `user_roles` covering **both** admins ⇒ **0 administrators lost** when
`is_admin()` repoints to `user_roles`. **Owner pre-check in the window:** re-run the
`unexpected` query; proceed only if still **0** (else add the reviewed admin to
`slab_admins` first — never auto-promote from app_metadata).

## Edge Function versions (prod, current)
`analyze-slab` v88 · `scan-card` v65 · `pricecharting-search` v99 ·
`pricecharting-marketplace`/`-sync` v61 · `marketplace-scheduler` v19 ·
`ebay-*` v61 (16 fns) · `market-intelligence` v15. No Edge Function redeploy is
required by these migrations; eBay production mutation switches **remain disabled**.

## Expected lock behavior
- `consume_grading_advice_quota` / `try_rate_limit_consume`: per-key
  `pg_advisory_xact_lock` — short, released at txn end; no table-wide locks.
- `20260909`/`20260910`: catalog/authority DDL + REVOKE/GRANT — brief ACCESS
  EXCLUSIVE on the named tables only.
- `20260911` indexes: use `CREATE INDEX CONCURRENTLY` on any large/hot table to
  avoid write blocking (verify per-index in #96).

## Maintenance-window estimate
~10–20 min: apply 20260905–20260913 (small DDL + function replaces), run the ledger
repair, then immediate contract verification. Grading tables are empty (fast).

## Rollback constraints
Confirmed backup / PITR window recorded **before** the first write (Phase 8 step 2).
Per-object DROP list for the 3 additive migrations (foundation/grading/rate-limit)
is enumerable and idempotent; function drifts (20260905/07) roll back by restoring
the captured prior definitions. Stop-and-rollback conditions: purge still absent
after apply, RLS regression, `is_admin` non-deterministic, any cross-user read,
new CRITICAL/HIGH advisor.

## Staging test results (carried)
All PR #97 staging checks PASS (7/7 fn byte-match, behavioral account deletion,
admin fail-closed, RLS, definer, 0 critical/high advisors) + disposable grading &
rate-limit verifies (`03`).

## Explicit confirmation
**`purge_customer_account_data` EXISTS and WORKS on staging** (`msbdwwgojuvgnuugrrry`):
present (md5 `136365bc`), and a synthetic self-purge was behaviorally verified
(FK-safe, target cleaned, unrelated preserved, storage queued, identity retained) —
PR #97. It is **absent in production**; migration #2 (`20260906`) installs it.

## Remaining before Gate A can be requested as fully green
- eBay `ebay_deletion_endpoint_settings` (absent in prod) + eBay token-storage
  canonicalization — reconcile as idempotent migrations (documented in `03`).
- Owner decision on whether to also fold the authority foundation into PR #95.
