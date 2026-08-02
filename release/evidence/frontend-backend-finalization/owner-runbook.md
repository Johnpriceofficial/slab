# Owner runbook — next steps (all owner-gated)

No production/staging/DNS/marketplace change has been made. These are the exact,
ordered actions to continue the release. Prerequisites and stop conditions noted.

## A. Vercel — create the git-connected frontend project

Vercel MCP can only deploy an inline file tree to a non-git-connected project, so
the git-connected import must be done in the Vercel dashboard. The merged frontend
`slab-scribe-pro/main` **builds cleanly for Vercel** (Nitro auto-detected the
Vercel preset, `nodejs22.x`, valid `.vercel/output`), so no code change is needed.

Vercel → Add New → Project → Import `Johnpriceofficial/slab-scribe-pro`:

```
Repository:        Johnpriceofficial/slab-scribe-pro
Production branch: main
Framework:         Vite / auto-detected TanStack Start
Install command:   npm ci
Build command:     npm run build
Output directory:  leave unset/default (Nitro emits .vercel/output)
Node.js:           22.x
Custom domains:    none        # do NOT add gradedcardvalue.com
```

Initial safe environment variables (self-contained; no backend, no secrets):

```
VITE_BACKEND_MODE=mock
VITE_RELEASE_ENVIRONMENT=staging
VITE_DEPLOYMENT_PROVIDER=vercel
```

After a **staging Supabase** exists, replace mock mode with:

```
VITE_SUPABASE_URL=<staging url>
VITE_SUPABASE_PUBLISHABLE_KEY=<staging anon/publishable key>   # public, safe
VITE_EXPECTED_SUPABASE_PROJECT_REF=<staging ref>
```

**Never** set these in the frontend/browser environment (build-exposed):

```
SUPABASE_SERVICE_ROLE_KEY  EBAY_CLIENT_SECRET  EBAY_REFRESH_TOKEN  DATABASE_URL
VITE_WHATNOT_CLIENT_SECRET  VITE_WHATNOT_LIVE_TOKEN
```

(The app's `assertNoWhatnotSecretsInBrowserEnv` guard throws if the Whatnot
secrets appear in browser env.) Do **not** touch the existing `slab-13rc` project.

## B. Supabase staging

Create a Supabase development branch or a separate staging project with
representative **synthetic** data (no copied customer data, service-role key, live
eBay token, or webhook secret).

## C. Backend migration reconciliation (staging-first)

Per `migration-ledger-reconciliation.md`:

1. `supabase migration list` / `supabase db diff` / `supabase db push --dry-run`
   on staging.
2. Review the `20260905`/`20260906`/`20260907` body diffs; confirm intended.
3. Apply `20260905`–`20260907` on staging; run account-deletion + admin +
   drift checks; then production.
4. `supabase migration repair` ledger ids `131106→20260907`, `131134→20260908`
   only after equivalence is proven on staging.
5. **Do not** mark `20260906` applied while `purge_customer_account_data` is absent.

## D. Backend remediation PRs (do not merge until the ledger is reconciled)

`slab` draft PRs, in order after reconciliation: #94 least-privilege grants →
#95 admin-authority unification (`user_roles`) → #96 supporting FK indexes → then
account-deletion (`20260906`) → then the frontend grading-quota / rate-limit
patches. Do not modify #94/#95/#96 unless a verified dependency requires it.

## E. Branch protection (after canonical is confirmed)

Require on `slab-scribe-pro/main` and `slab/main`: PRs, CI release gate, typecheck,
lint, unit tests, production build, Playwright, secret scan, dependency audit, and
(for `slab`) migration-chain verification.

## F. Domain (last)

Only after staging passes: add `gradedcardvalue.com` + `www` to the new Vercel
project, verify Vercel DNS records, update Cloudflare DNS, keep TLS + apex/www
redirect, keep the current Cloudflare deployment as rollback, then production
smoke tests. **Production domain untouched until then.**
