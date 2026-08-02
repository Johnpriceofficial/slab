# 07 — Staging application + acceptance (Step 3)

Applied the full sequence to Supabase staging `msbdwwgojuvgnuugrrry` via canonical
migration tooling (management API `apply_migration`), in ascending order. No
undocumented ad-hoc schema DDL.

| Migration | Method | Result |
| --- | --- | --- |
| `20260908500000_authority_foundation` | formal reconcile (objects present via phase_2a; verified `user_roles`+`has_role`(secdef,pinned)+`app_role` labels) | ✅ |
| `20260909000000_least_privilege_authz_tables` (#94) | apply | ✅ |
| `20260910000000_admin_authority_unification` (#95) | apply (gate `unexpected=0`) | ✅ `is_admin` now reads `user_roles` |
| `20260911000000_supporting_fk_indexes` (#96) | apply (17 plain indexes) | ✅ |
| `20260912000000_grading_advisor` | apply | ✅ 16 grading tables |
| `20260913000000_atomic_rate_limit_consume` | apply | ✅ `rate_limit_hits`+`try_rate_limit_consume`+`prune_rate_limit_hits` |

## Post-apply security posture (staging)
- 16 grading tables, **0 without RLS**; `rate_limit_hits` RLS on.
- **0** SECURITY DEFINER functions without pinned `search_path`.
- `is_admin` reads `user_roles` (not `raw_app_meta_data`).
- `consume_grading_advice_quota` = authenticated-only; `try_rate_limit_consume` =
  service-role-only; authenticated cannot UPDATE `grading_advisor_usage`; anon
  cannot SELECT `grading_companies`.

## Behavioral acceptance (synthetic accounts, guaranteed rollback)
`quota_first=t quota_second=t runs_used=1 rl_first=t rl_second=f malformed_rejected=t`
⇒ quota idempotency (charged once), atomic rate-limit boundary (2nd denied),
malformed args rejected. **0 synthetic rows persisted** (verified post-rollback).

## Fix applied during acceptance — D-5 (P2)
Advisor flagged `prune_rate_limit_hits()` as **anon-executable** (default PUBLIC
execute on a SECURITY DEFINER fn). Root-caused to the source patch never revoking
it. Fixed on staging **and** in the canonical `20260913` migration:
`REVOKE ALL … FROM public, anon, authenticated; GRANT EXECUTE … TO service_role`.
Re-verified: `anon=false, authenticated=false, service_role=true`.

## Security advisors (staging, post-fix)
**0 CRITICAL / 0 HIGH.** Remaining are by-design: `authenticated_security_definer_
function_executable` WARNs (the guarded RPC surface — each enforces ownership
internally), `rls_enabled_no_policy` INFO on deny-all internal/service-role tables
(`rate_limit_hits`, `api_*`, private `ebay_*`, tombstones), and the owner-toggle
`auth_leaked_password_protection` WARN. The prior anon-prune WARN is resolved.

## Ledger note
`apply_migration` assigns management-API timestamps (`20260801xxxxxx`) but records
the canonical name (`grading_advisor_20260912000000`, etc.). Production uses the
same method; the canonical version numbers are reconciled in the ledger there.
