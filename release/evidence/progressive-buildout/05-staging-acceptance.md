# 05 — Staging acceptance (Phase 7, partial)

Honest status. The **live** staging matrix (frontend running on the new Vercel
project against Supabase staging) is **gated on Phase 2** (owner Vercel import).
What is proven without it is marked; what needs the deployed app is `NOT TESTED
(Vercel-gated)`.

## Proven now (disposable PG + Supabase staging + CI)
| Area | Status | Evidence |
| --- | --- | --- |
| Frontend build for Vercel | **PASS** | `slab-scribe-pro@eadeedf9` CI "Production build" green; Nitro Vercel preset |
| Frontend unit tests + coverage | **PASS** | CI "Unit tests & coverage thresholds" green |
| Frontend typecheck / lint / format | **PASS** | CI green (3 checks) |
| Frontend access-control E2E | **PASS** | CI "Playwright access-control suite (required)" green |
| Backend contract freshness | **PASS** | CI "Backend contract freshness (release blocker)" green |
| Secret scan | **PASS** | CI "Secret scan" green |
| Clean migration chain (canonical) | **PASS** | PR #97 Test A (69 from zero) |
| Production-shaped upgrade | **PASS** | PR #97 Test B |
| Canonical fn reconciliation on staging | **PASS** | 7/7 byte-match (PR #97) |
| Account deletion (purge) on staging | **PASS** | behavioral self-purge (PR #97) |
| Admin authority fail-closed | **PASS** | staging + disposable |
| RLS + pinned search_path | **PASS** | schema-assertions (disposable) |
| Grading quota + catalog RLS | **PASS** | `grading-advisor-tests.sql` (disposable, 75-chain) |
| Atomic rate limiting | **PASS** | `atomic-rate-limit-tests.sql` (disposable) |
| Security advisors (staging) | **PASS** | 0 CRITICAL / 0 HIGH (PR #97) |

## Required live matrix — NOT TESTED (Vercel-gated)
Authentication · tenant isolation · raw scanner · slab creation · correction ·
inventory IDs · archive/unarchive · valuation · grading advice (also frontend-
**unwired** today) · quota (live) · catalog visibility (live) · PriceCharting ·
eBay sandbox · contact delivery · account deletion (live) · administrator
authorization (live) · rate limiting (live) · storage cleanup · mobile ·
accessibility.

⇒ These run once the owner imports `slab-scribe-pro` into the new Vercel project
(`01-vercel-staging-creation.md`) and Phase 3 wiring completes.

## Gate status
- P0/P1: **none open** in what has been tested. **D-4 (P1)** is *resolved* by the
  authority foundation (verified); its production application is Gate-A scoped.
- Rollback plan: `rollback-plan.md` (tested paths for disposable + staging).
- Production promotion manifest: `06-production-promotion-packet.md`.
