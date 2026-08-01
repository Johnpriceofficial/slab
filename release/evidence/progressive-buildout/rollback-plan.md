# Rollback plan (progressive buildout)

Every step below is reversible without touching production until the two
production gates. Rollback targets are recorded as they become real.

## Phase 0 — source of truth
Read-only. Nothing to roll back.

## Phase 1 — release branches
- Backend branch `release/backend-production-completion` (from `slab@c65d438`).
- Frontend branch `release/vercel-staging-live-integration` (from `slab-scribe-pro@eadeedf9`).
- Draft PRs opened against `main` (never auto-merge).
- **Rollback:** close the draft PRs and delete the branches. `main` is never touched.

## Phase 2 — new Vercel staging project (OWNER-BLOCKED)
- No change performed by automation. Creation is a Vercel dashboard git-import
  (see `01-vercel-staging-creation.md`).
- **Rollback:** delete the new Vercel project. `slab-13rc` is never modified.

## Phase 3 — staging Supabase auth redirect allowlist
- Only staging (`msbdwwgojuvgnuugrrry`) Auth URLs change.
- **Rollback:** remove the added redirect URLs from staging. Production Auth URLs
  are never touched in this phase.

## Phase 4 — backend canonicalization (branch only)
- New canonical migrations (`20260912+`) live only on the backend release branch
  and are verified on disposable PostgreSQL (and, if run, staging).
- **Rollback (disposable):** drop the disposable container — nothing persists.
- **Rollback (staging):** `reset_branch(msbdwwgojuvgnuugrrry, 20260904000000)` or
  drop the specific new objects; captured object list required before any apply.
- Production receives nothing in this phase.

## Phase 5 — remediation PRs (#94/#95/#96)
- Rebased onto current `main` on their own branches; verified on staging.
- **Rollback:** the branches/PRs are independent; nothing merges to `main`
  without owner review. Staging: `reset_branch` to the pre-apply version.

## Production Gate A / Phase 8 — production DB promotion (owner-approved only)
- **Pre-req:** confirmed current backup / PITR window recorded here before any write.
- **Rollback:** restore from the recorded backup; the promotion applies only the
  exact verified canonical objects, so per-object DROP is also enumerated in the
  promotion packet (`06-production-promotion-packet.md`).
- Stop conditions abort-and-rollback: purge missing after apply, RLS regression,
  admin authority non-deterministic, cross-user access, new critical/high advisor.

## Production Gate B / Phase 10 — DNS cutover (owner-approved only)
- **Rollback:** restore the recorded Cloudflare DNS records (captured verbatim
  before the change); the old Cloudflare origin stays live during stabilization.
