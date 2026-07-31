# Migration ledger reconciliation manifest

**Date:** 2026-07-31 · **Method:** read-only. Prod ledger
(`supabase_migrations.schema_migrations`) vs canonical repo `main@c65d438`
(`supabase/migrations/`), cross-checked against live schema objects. No writes.

## Summary

| | Count | Tip |
|---|---|---|
| Production ledger (recorded) | **67** | `20260904000000` |
| Canonical repo (`main`) | **69** | `20260908000000_slab_permission_model` |

- **65 migrations** are recorded **and** in the repo → aligned.
- **2 ledger rows** exist in prod but are **not** canonical repo versions (out-of-band).
- **4 canonical migrations** (`20260905`–`20260908`) are **absent from the ledger**.

This is why `supabase db push` / branch status reports `MIGRATIONS_FAILED`: the CLI
sees canonical versions that aren't recorded, sitting behind out-of-band rows.

## The two out-of-band ledger rows = the same work, applied early

| Out-of-band version (recorded in prod) | `name` | Canonical equivalent |
|---|---|---|
| `20260729131106` | `save_confirmed_slab_from_analysis` | `20260907000000_save_confirmed_slab_from_analysis` |
| `20260729131134` | `slab_permission_model` | `20260908000000_slab_permission_model` |

The atomic-save + permission-model work was applied to production **early**, on
2026-07-29, under ad-hoc timestamps — then later canonicalized in the repo as
`20260907`/`20260908`. Same schema, different ledger id → "timestamp-renamed".

## Classification of the 4 canonical migrations missing from the ledger

Verified against **live** schema objects:

| Canonical migration | Key object(s) | Live in prod? | Classification |
|---|---|---|---|
| `20260905000000_analyze_slab_link_hardening` | `link_ai_analysis_run` (hardened, owner-guarded) | ✅ present | **applied-but-unrecorded** |
| `20260906000000_account_deletion` | `purge_customer_account_data` | ❌ **absent** | **absent** (non-launch feature) |
| `20260907000000_save_confirmed_slab_from_analysis` | `save_confirmed_slab_from_analysis` | ✅ present | **timestamp-renamed** → `20260729131106` |
| `20260908000000_slab_permission_model` | triggers `guard_slab_protected_columns`, `forbid_direct_slab_delete`; policies `slabs_owner_select`/`slabs_admin_select`; `correct_slab_identification` | ✅ present | **timestamp-renamed** → `20260729131134` |

**Net:** every *launch-critical* schema change is genuinely applied and live-verified.
The only genuinely-absent canonical migration is `20260906` (account deletion), a
non-launch feature. Functional risk is **low**; the risk is **ledger integrity** —
future migrations can't be cleanly pushed until the ledger is reconciled.

## Recommended reconciliation — non-destructive, OWNER-applied

> Do **not** hand-insert fake rows or re-run applied migrations. Use the CLI's
> repair mechanism so the ledger reflects reality.

1. **Mark the applied-but-unrecorded / timestamp-renamed canonical versions as applied**
   (they are already in the schema — repair only records them):
   ```bash
   supabase migration repair --status applied 20260905000000
   supabase migration repair --status applied 20260907000000
   supabase migration repair --status applied 20260908000000
   ```
   Optionally also mark the two out-of-band rows reverted so the ledger stops
   carrying duplicate entries for the same objects (verify first):
   ```bash
   supabase migration repair --status reverted 20260729131106 20260729131134
   ```
2. **Decide `20260906_account_deletion`:** it is a non-launch feature and is not
   applied. Either apply it deliberately on staging → prod, or move the file out of
   the canonical `main` chain until the account-deletion feature is scheduled. Do
   not leave it as a silent gap.
3. **Re-run** `supabase migration list` (local vs remote) until they match, then
   confirm branch status leaves `MIGRATIONS_FAILED`.
4. Only after the ledger matches, apply later migrations (e.g.
   `20260909000000_least_privilege_authz_tables.sql` in PR #94).

## Appendix — full recorded ledger (67)

`20260709…20260729000000`, **`20260729131106`**, **`20260729131134`**,
`20260730…20260836000000`, `20260901…20260904000000`.
(Canonical repo adds `20260905`, `20260906`, `20260907`, `20260908`.)
