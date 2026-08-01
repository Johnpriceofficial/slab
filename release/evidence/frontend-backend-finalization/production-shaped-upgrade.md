# Test B — production-shaped upgrade

**Result: PASS** (upgrade path clean), with a documented fidelity caveat.

## Modeled base

A fresh disposable DB was built from the canonical migrations **through the
production ledger tip** `20260904000000_slab_deletion_tombstones_rls`:

- base migrations applied: **65** (`20260709…` → `20260904…`), all clean.
- `purge_customer_account_data` present at base: **no** (correct — it is created
  by `20260906`).

## Upgrade to canonical tip

The canonical upgrade `20260905000000` → `20260908000000` (4 migrations) applied
cleanly on the prod-shaped base:

```
✔ 20260905000000_analyze_slab_link_hardening.sql
✔ 20260906000000_account_deletion.sql
✔ 20260907000000_save_confirmed_slab_from_analysis.sql
✔ 20260908000000_slab_permission_model.sql
```

- `purge_customer_account_data` present after upgrade: **yes** (created by `20260906`).

## Fidelity caveat (material — read with the reconciliation)

The base was built from **canonical `<=20260904` definitions**. Production's real
state additionally contains **out-of-band objects** not modeled here:

- drifted bodies of `link_ai_analysis_run`, `save_confirmed_slab_from_analysis`,
  `list_pending_slab_storage_cleanup` (prod versions differ from canonical);
- `has_role()`, `app_role` type, `public.user_roles` — split-administrator-authority
  artifacts present in production but **not created by any canonical migration**.

Because the exact out-of-band migration SQL is not in the repository, the upgrade
base cannot fully reproduce production. Applying `20260905`/`20260906`/`20260907`
to production would `CREATE OR REPLACE` the drifted functions to the canonical
definitions and create `purge_customer_account_data`; `20260908`'s declared
objects are already equivalent in production. **These are owner-gated and must be
rehearsed against a real staging Supabase** (a full `supabase db diff` / dry-run)
before any production apply. See `migration-ledger-reconciliation.md`.
