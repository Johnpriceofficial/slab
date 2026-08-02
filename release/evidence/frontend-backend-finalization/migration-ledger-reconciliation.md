# Migration-ledger reconciliation — canonical `20260905`–`20260908` vs production

Production `rcbwemkfcefarqnlgrmv`, read-only. Compared by **normalized function
body** (`md5(regexp_replace(prosrc,'\s+',' '))`) and object existence — **never by
filename**. Machine-readable: `migration-ledger-reconciliation.json`.

Production ledger tip: `20260904000000_slab_deletion_tombstones_rls`.
Out-of-band prod ledger entries: `20260729131106_save_confirmed_slab_from_analysis`,
`20260729131134_slab_permission_model`.

| Canonical | Objects | Prod presence | Definition equivalence | **Status** |
| --- | --- | --- | --- | --- |
| `20260905_analyze_slab_link_hardening` | `link_ai_analysis_run` | present | **DIFFERS** (`fecac022…` vs `cea8c9ef…`) | **PARTIALLY PRESENT** |
| `20260906_account_deletion` | `purge_customer_account_data`, `list_pending_slab_storage_cleanup` | purge **ABSENT**; list_pending present | list_pending **DIFFERS** (`ee13223d…` vs `fc3218f8…`) | **ABSENT** |
| `20260907_save_confirmed_slab_from_analysis` | `save_confirmed_slab_from_analysis` | present via out-of-band `131106` | **DIFFERS** (`c5265afe…` vs `53652291…`) | **PARTIALLY PRESENT** |
| `20260908_slab_permission_model` | 3 fns + `slab_correction_events` + 2 slabs policies | all present via out-of-band `131134` | 3 fns **IDENTICAL** (`b38bf027…`,`0db91967…`,`90cb13a8…`) | **EQUIVALENT UNDER DIFFERENT LEDGER ID** |

## Key facts

- **`purge_customer_account_data` is ABSENT in production.** Per the required
  rule, `20260906` is **not** applied and must not be marked/repaired-as-applied.
  Account deletion is therefore **not deployed** to production.
- `20260908`'s declared objects are **body-identical** in production (applied
  out-of-band as `131134`), so its ledger id can be **repaired** (not re-applied)
  after staging confirms full equivalence.
- Production additionally carries **`has_role()`, `app_role`, `public.user_roles`**
  — administrator-authority objects **not created by any canonical migration**.
  This is the split-authority state; unification to a single canonical source
  (`user_roles`) is **draft PR #95**, unmerged and owner-gated. Do **not** silently
  drop these.
- `20260905` and `20260907` functions exist in production but with **drifted
  bodies**; the canonical (reconciled/hardened) definitions are not applied.

## Safe repair sequence (owner-gated, staging-first — do NOT run on production here)

1. Rehearse on a real staging Supabase: `supabase migration list`,
   `supabase db diff`, `supabase db push --dry-run`.
2. Confirm each definition diff is intended (review `link_ai_analysis_run`,
   `save_confirmed_slab_from_analysis`, `list_pending_slab_storage_cleanup`).
3. Apply `20260905`, `20260906`, `20260907` on staging; run the account-deletion,
   admin-authority and drift checks; then promote to production.
4. `supabase migration repair` the ledger ids `131106→20260907` and
   `131134→20260908` **only after** definition equivalence is proven on staging.
5. Handle the `has_role`/`app_role`/`user_roles` split separately via PR #95.

**Stop conditions:** never `migration repair` against production from here; never
mark `20260906` applied while `purge_customer_account_data` is absent; never repair
`131106→20260907` until the body is applied or proven equivalent.
