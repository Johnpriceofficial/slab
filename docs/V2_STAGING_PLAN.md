# V2 Staging Plan (proposal only — no staging is created by this document)

Source commit `ba3953fdb68c31435c7dac732f67d8d53aa2adcb` · 2026-07-27 · Part of the V2 backend contract bridge.
**Nothing in this plan is executed in this milestone. No Supabase branch is created. No costs are incurred.**

## Proposed architecture

- **Staging database:** one Supabase preview branch of `rcbwemkfcefarqnlgrmv`, created the proven way (a PR-preview branch or an explicitly approved CLI branch). Branch creation replays the canonical 65-migration chain — validated repeatedly (63/64/65-migration previews all reached `MIGRATIONS_PASSED` first try). The GitHub-integration Branch limit is currently **2** (`main` + one preview); creating a dedicated long-lived staging branch alongside PR previews will require raising it to 3 — an explicit settings approval, called out here so it is not a surprise.
- **Staging frontend:** the Lovable V2 app in its own Lovable environment, pointed at the staging branch's URL + anon key via environment variables. Lovable is never pointed at production during staging.
- **Edge functions:** deploy to the staging branch only (branch projects get their own function deployments via the normal push flow). External providers stay disabled by default (below).

## Environment variables (names only — values live in approved secret stores)

| Name | Purpose | Staging value policy |
|---|---|---|
| `VITE_SUPABASE_URL` / V2 equivalent | branch API URL | staging branch URL |
| `VITE_SUPABASE_ANON_KEY` / V2 equivalent | branch anon key | staging branch key |
| `BACKEND_MODE` (V2) | `mock` / `staging` / `production` | `staging` |
| Provider keys (PriceCharting, AI, eBay) | edge-function secrets | **absent or sandbox-only** in staging |

## Disabled integrations in staging

- eBay: OAuth against sandbox only, or the connection flow disabled (`EBAY_NOT_CONNECTED` surfaced); never live listing/order calls.
- PriceCharting: fixture adapter (the repo already has benchmark fixtures under `scripts/benchmark/fixtures/`) or a low-quota sandbox key.
- AI analysis: fixture responses by default (`analyze-slab` has a deterministic dry-run path in the benchmark tooling); real scans only by explicit choice.
- Schedulers/workers: none exist; none are enabled.
- Storage deletion / cleanup queue consumption: disabled — same posture as production.

## Fixtures

- Seed via the existing integration-test creation paths (`create_slab` RPC, service-role inserts) — the serial integration suite already builds every fixture it needs and cleans up after itself.
- A small demo dataset for Lovable UI work: ~10 slabs across graders/finishes, 2 raw cards, 1 eBay account row in `disconnected` state, sample analysis + evidence rows. Seeded by a script (to be written in the staging milestone) that uses only the public RPC surface — never direct service-role writes for things RPCs can do.

## Test users

| User | Purpose | Mechanism |
|---|---|---|
| `staging-admin@…` | admin surfaces | `slab_admins` row + `app_metadata.graded_card_value_admin` |
| `staging-customer-a@…` | owner-scoped flows | plain authenticated user |
| `staging-customer-b@…` | cross-tenant isolation checks | plain authenticated user |
| service role | fixtures/seeding only | never shipped to the Lovable app |

## Mock-to-staging replacement order (mirrors the handoff doc)

1. Auth + profile (`getSession`, `signIn`, `getCurrentProfile`)
2. Read-only inventory (`listSlabs`, `getSlab`, dashboard summary)
3. Intake + upload (`createSlabIntake`, `uploadSlabImage`)
4. Analysis (`startSlabAnalysis`, `getAnalysis`, confirm/correct)
5. Pricing evidence + comparables
6. Admin review surfaces
7. eBay (sandbox only, last)

## Prerequisites before any staging creation (future approvals)

1. Approval to raise the Supabase Branch limit 2 → 3 (or to time-share the single preview slot).
2. Approval to create the staging branch (cost acknowledged; Branching Compute is outside the Spend Cap per the dashboard warning).
3. Contract package (this milestone) merged so the branch carries the canonical 65-migration chain and the contracts are importable.
4. Secret provisioning in approved stores for whichever providers are enabled in sandbox mode.
