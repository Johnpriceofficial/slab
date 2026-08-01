# 03 — Backend canonicalization (Phase 4)

Canonicalizes frontend-owned `backend-patches/` behavior into `slab`, verified
**clean-from-zero on disposable PostgreSQL** (no production, no customer data).

## New canonical migrations (this branch)

| Migration | Source patch | What it adds | Verified |
| --- | --- | --- | --- |
| `20260908500000_authority_foundation.sql` | `20260729-user-roles-foundation` | `app_role` enum, `public.user_roles` (+RLS select-own, service-role writes), `has_role()` SECURITY DEFINER | ✅ |
| `20260912000000_grading_advisor.sql` | `20260731-grading-advisor` | 15 grading tables (catalog + customer advice + usage), owner-scoped RLS, catalog published-only RLS, `consume_grading_advice_quota()` idempotent SECURITY DEFINER quota | ✅ |
| `20260913000000_atomic_rate_limit_consume.sql` | `rate-limit-atomic` + `docs/backend-patches/rate_limit_hits.sql` | `rate_limit_hits` (RLS, service-role only) + `try_rate_limit_consume()` sliding-window SECURITY DEFINER + `prune_rate_limit_hits()` | ✅ |

### Canonicalization edits (documented, not blind copies)
- **grading**: removed the patch's staging-only **production-refusal guard** and the
  schema-wide `revoke all on all tables in schema public from public` blanket
  (each grading table already revokes per-table; the blanket would touch unrelated
  tables). All table/RLS/grant/definer/quota logic is otherwise verbatim.
- **rate-limit**: combined the table DDL + function into one migration; documented
  that it is **distinct** from the existing `public.api_rate_limits` /
  `reserve_api_request_slot` (a *pacing/reservation* limiter for PriceCharting) —
  this is a *count-and-deny sliding window* for public endpoints with a **live
  call site** (`slab-scribe-pro src/integrations/security/rate-limit.server.ts`,
  service-role, fail-closed). Not a duplicate; genuinely missing.
- **authority foundation**: idempotent (`create … if not exists`, `add value if
  not exists`), so at Gate A it reconciles against prod's out-of-band objects as a
  `migration repair` (mark applied after equivalence), not a re-create.

## ⚠ Confirmed defect D-4 (P1 — reported; explains D-1)

**Neither PR #94 (`20260909`) nor PR #95 (`20260910`) creates
`public.user_roles` / `public.app_role` / `public.has_role` — both only
*reference* them.** Those objects exist in prod/staging **only out-of-band**
(the `user-roles-foundation` patch was applied directly, never canonicalized).

- A clean `main` + #94 + #95 apply **fails at #94** (`relation "public.user_roles"
  does not exist`) — reproduced here.
- This is the concrete cause of **D-1** (`MIGRATIONS_FAILED` on the prod default
  control-plane branch): the canonical chain cannot replay onto the out-of-band
  production schema.
- **Resolution (verified):** canonicalize `20260908500000_authority_foundation.sql`
  **before** #94/#95. With it in place, the full chain applies clean from zero.
- **Phase-5 action:** rebase PR #95 on top of the foundation (or fold the
  foundation into the front of #95 and order it before #94). `slab_admins` **is**
  canonical (`20260709_slab_admin`); only the `user_roles` authority was missing.

## Proven canonical landing sequence (disposable PostgreSQL, from zero)
```
canonical 69 (→20260908) → 20260908500000 authority-foundation
→ 20260909 (#94 least-privilege) → 20260910 (#95 admin unification)
→ 20260911 (#96 fk indexes) → 20260912 grading → 20260913 rate-limit
= 75 migrations applied, 0 manual interventions
```
Verification output:
```
SCHEMA ASSERTIONS PASS  (0 SECURITY DEFINER without pinned search_path;
                         all public+private tables RLS-on; is_admin + purge present)
GRADING-ADVISOR VERIFY: PASS
  - quota idempotency (retry consumes once), boundary (deny at limit),
    cross-user isolation (A cannot read B usage), catalog published-only reads
    (draft/retired hidden), child-parent visibility, authenticated + admin
    direct-write denial (insufficient_privilege), service-role maintenance.
ATOMIC RATE-LIMIT VERIFY: PASS
  - malformed args rejected (empty bucket/key, non-positive max, reversed
    timestamps, >1d window) → 22023; first consume allowed, second denied
    (atomic last-slot); PUBLIC/anon/authenticated denied, service_role only.
```
Repeatable scripts committed: `scripts/verify/grading-advisor-tests.sql`,
`scripts/verify/atomic-rate-limit-tests.sql` (both `begin…rollback`, RAISE on any
unmet assertion). Full-chain runner: the disposable postgres:17 harness in
`scripts/verify/migration-chain.sh` extended with the three new files.

## Remaining Phase-4 work (documented; not yet done)
- **Frontend contract snapshot regen** (step 8): `slab-scribe-pro
  scripts/contract-snapshot.json` should be regenerated against the canonical
  backend once these land; the grading advisor is currently **unwired** in the
  frontend (no `consume_grading_advice_quota`/`grading_companies` call sites), so
  step 9 ("remove any 'ready' claim for an unpromoted op") is a no-op today but
  must be re-checked when the grading UI is wired.
- **eBay token storage / account foundation** (`20260730-*`): reconcile against
  prod's existing eBay tables before porting — not yet done (needs a prod-object
  inventory; deferred to avoid duplicating out-of-band objects).

## Safety
Production Supabase modified: **NO** · Production ledger modified: **NO**.
All verification ran on a disposable `postgres:17` container that was destroyed.
