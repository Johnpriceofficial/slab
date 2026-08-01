# Staging reconciliation rehearsal — `msbdwwgojuvgnuugrrry`

Rehearsed the canonical `20260905`–`20260908` reconciliation on the **staging**
branch `msbdwwgojuvgnuugrrry` (parent prod `rcbwemkfcefarqnlgrmv`, no customer
data). **Production was not touched** — verified after: `purge_customer_account_data`
still absent, `link_ai_analysis_run` still `fecac022…`, zero `20260905+` in the
production ledger.

## Staging before-state (read-only)
Ledger tip `20260904000000`, with staging-specific out-of-band entries
(`20260729075640` save_confirmed, `20260729075826` slab_permission_model_reconciled,
`phase_2a_*` user_roles/account foundations) — distinct from prod's (`131106`/`131134`).
Drift confirmed: `link`/`list_pending`/`save_confirmed` older bodies; `correct_slab_identification`
older (`04b3f613…`); `purge_customer_account_data`, `forbid_direct_slab_delete`,
`guard_slab_protected_columns` **absent**. Prior definitions of the four to-be-replaced
functions were captured for rollback.

## Applied (staging only, verbatim from the repo files)
| Migration | Applied | Post-apply body md5 == canonical |
| --- | --- | --- |
| `20260905_analyze_slab_link_hardening` | yes | `link_ai_analysis_run` ✅ `cea8c9ef` |
| `20260906_account_deletion` | yes | `purge_customer_account_data` ✅ `136365bc`; `list_pending` ✅ `fc3218f8` |
| `20260907_save_confirmed_slab_from_analysis` | yes | `save_confirmed` ✅ `53652291` |
| `20260908_slab_permission_model` | yes | `correct` ✅ `b38bf027`, `forbid` ✅ `0db91967`, `guard` ✅ `90cb13a8` |

**7 / 7 target functions byte-match canonical** after applying. `slab_correction_events`
table present, 2 slabs protect-triggers (`forbid`/`guard`) present, 2 slabs policies
(`owner_select`/`admin_select`) present.

Note: staging's `20260908` was **not** a pure ledger-equivalence case (unlike prod):
`forbid`/`guard` were absent and `correct` was an older body, so `20260908` was
**applied**, not repaired — exactly the "confirm equivalence first" rule.

## Behavioral + security verification (on staging)
- **Account deletion works:** synthetic self-purge — unauthenticated refused (`AUTH_REQUIRED`),
  FK-safe self-purge, target data cleaned, unrelated user + slab intact, storage enqueued,
  auth identity retained (separate post-cleanup step). All synthetic test data cleaned up
  (0 residue verified).
- **Administrator authority fail-closed:** `is_admin(random_uid)` = false.
- **Schema properties:** 0 SECURITY DEFINER functions without pinned `search_path`; 0 public
  tables without RLS.
- **Security advisors (post-migration):** 0 CRITICAL / 0 HIGH; the WARN set is the known,
  by-design guarded-definer-RPC surface (now including the applied functions) + the auth
  leaked-password toggle; INFO `rls_enabled_no_policy` on internal/service-role tables (deny-all
  by design).

## Rollback
Reset the staging branch (`reset_branch`) to `migration_version 20260904000000`, or restore the
four captured prior function definitions + drop `purge_customer_account_data`/`forbid`/`guard` and
the `slab_correction_events` additions.

## Fidelity note
Migrations were applied via the Supabase management API as verbatim repository SQL and
independently confirmed byte-identical to canonical via normalized body md5. The owner's
production apply should use the supported `supabase db push` of the exact repo files, then
`supabase migration repair` the staging/prod out-of-band ledger ids after confirming equivalence
(see `migration-ledger-reconciliation.md`). The `has_role`/`app_role`/`user_roles` split-authority
objects (present in staging via `phase_2a`, in prod out-of-band) are handled separately by PR #95.
