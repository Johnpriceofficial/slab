# 08 — Production backend promotion (Step 9)

Applied the verified canonical sequence to production `rcbwemkfcefarqnlgrmv` via
`apply_migration` (management API), in ascending order, after capturing the
rollback baseline. **Marketplace/eBay production mutations remain disabled.**

## Rollback baseline captured (pre-write)
Ledger 67 entries @ tip `20260904`; prior definitions of `link_ai_analysis_run`,
`list_pending_slab_storage_cleanup`, `save_confirmed_slab_from_analysis`, `is_admin`
recorded; `purge_customer_account_data` confirmed absent; excess `user_roles`
grants (`TRUNCATE/REFERENCES/TRIGGER` for authenticated) recorded.

## Applied / reconciled (in order)
| Migration | Action | Result |
| --- | --- | --- |
| `20260905` link hardening | APPLY (verbatim) | `link` → `cea8c9ef` ✅ |
| `20260906` account deletion | APPLY (verbatim) | `purge` created → `136365bc`; `list_pending` → `fc3218f8` ✅ |
| `20260907` save_confirmed | APPLY (verbatim) | `save_confirmed` → `53652291` ✅ |
| `20260908` slab_permission_model | RECONCILE | correct/forbid/guard + slab_correction_events present ✅ |
| `20260908500000` authority_foundation | RECONCILE | user_roles/app_role/has_role present out-of-band ✅ |
| `20260909` #94 least-privilege | APPLY | excess grants revoked (authenticated TRUNCATE=false) ✅ |
| `20260910` #95 admin unification | APPLY | is_admin→user_roles; **user_roles admins=2, 0 lost** ✅ |
| `20260911` #96 fk indexes | APPLY | 17 indexes ✅ |
| `20260912` grading_advisor | APPLY | 16 grading tables, 0 without RLS ✅ |
| `20260913` atomic_rate_limit | APPLY | rate_limit_hits + try_rate_limit_consume + prune (service-role-only) ✅ |

> The three function migrations were first applied compressed (comment/whitespace
> drift → md5 mismatch), then **re-applied verbatim** to achieve byte-exact
> canonical bodies. Reconcile-by-definition was used for `20260908`/foundation
> because their objects already existed out-of-band (owner's "reconcile equivalent
> out-of-band objects by definition" rule) — never marked applied while absent.

## Production verification (post-apply)
- **7/7 canonical functions byte-match** (`all_7_match: true`).
- `purge_customer_account_data` present; **behavioral account-deletion PASS** on a
  disposable production test account (synthetic, full rollback, 0 persistence):
  unauthenticated refused, cross-user denied, `is_admin(synthetic)=false`, self-purge
  returns target, auth identity retained. No real customer row touched.
- Administrator authority deterministic: `is_admin` reads `user_roles`,
  `user_roles` administrators = 2 (both prior app-metadata admins backfilled) —
  **0 administrators lost**.
- Least-privilege active: `authenticated` no longer holds TRUNCATE on `user_roles`.
- RLS: 16 grading tables all RLS-on; `rate_limit_hits` RLS-on; **0** SECURITY
  DEFINER functions without pinned `search_path`.
- `try_rate_limit_consume` = service-role only; `prune_rate_limit_hits` **not**
  anon-executable (D-5 fix live in prod).
- **Security advisors: 0 CRITICAL / 0 HIGH.** WARNs are the by-design guarded-RPC
  surface + the owner `auth_leaked_password_protection` toggle; INFO
  `rls_enabled_no_policy` on deny-all internal/service-role tables.
- No secret or customer data written to logs/evidence (aggregate counts only).

## Ledger reconciliation
Ledger 67 → 80 (10 canonical applies + 3 verbatim re-applies). Canonical-named
entries recorded (`*_20260905000000` … `*_20260913000000`). The out-of-band
`20260729131106`/`131134` entries remain as historical records; the schema is now
canonical and the ledger documents the executed behavior.

## Residual (not a stop condition)
The default control-plane branch `b317ade1` still reports **`MIGRATIONS_FAILED`**
(`updated_at 2026-07-27`, unchanged by this work). `apply_migration` updates the
DB + ledger but not the default branch's control-plane status flag, and no MCP
tool resets the *default* branch. DB is `ACTIVE_HEALTHY` and serving. Clearing the
flag is a Supabase dashboard/support action. Per the owner's caution, this work is
proven to fix clean-chain failure and is a **likely contributor** to the
control-plane state; direct platform evidence that it is the sole cause is not
available.

## Safety
Production customer data migrated: **NO** (schema/function only; no customer rows
altered). Customer data lost: **NO**. Production secret exposed: **NO**. Live
marketplace mutation: **NO**. Rollback used: **NO** (all stop conditions clear).
