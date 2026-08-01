# 01 — New Vercel staging project (Phase 2) — OWNER-BLOCKED

## Status: owner action required (no safe automated path)

A **git-connected** Vercel project cannot be created from this session:

| Attempted supported path | Result |
| --- | --- |
| Vercel MCP `deploy_to_vercel` | ❌ Forbidden by the brief — it is a **"no git repo"** inline/detached deploy ("do not create an inline file-snapshot project"). It cannot establish a `main`→auto-deploy git integration. |
| Vercel CLI (`vercel git connect`) | ❌ No `vercel` CLI installed and no `VERCEL_TOKEN` in the environment. |
| Vercel REST API project+gitRepository | ❌ Requires the Vercel↔GitHub app installed on `Johnpriceofficial` and an API token; both are owner-scoped OAuth actions. |

Per the brief this step is **marked owner-blocked** and all non-dependent phases
continue. **No inline snapshot and no detached copy were deployed.**

## Exact owner dashboard action

1. https://vercel.com/john-price → **Add New… → Project**.
2. **Import Git Repository** → authorize the Vercel GitHub app for
   `Johnpriceofficial` if prompted → select **`Johnpriceofficial/slab-scribe-pro`**.
3. Configure:
   - **Project name:** `graded-card-value-staging`
   - **Production branch:** `main`
   - **Framework preset:** let Vercel auto-detect (TanStack Start / Vite); do not force.
   - **Install command:** `npm ci`
   - **Build command:** `npm run build`
   - **Output directory:** leave **unset/default** (Nitro emits the Vercel Build
     Output API tree under `.output` when it detects `VERCEL=1`).
   - **Node.js version:** **22.x** (Project Settings → General → Node.js Version).
   - **Custom domain:** none.
   - **Do NOT** touch `slab-13rc` (`prj_s3HNK69VRTNimpNMQnxxP9JyA575`).

## First deployment env (mock mode — Phase 2)

Set on the new project (Preview + Production scopes), then trigger the first build:

```
VITE_BACKEND_MODE=mock
VITE_ALLOW_MOCK_DATA=true
```

> Note: the app's real contract uses `VITE_BACKEND_MODE`, not the brief's
> `VITE_RELEASE_ENVIRONMENT`/`VITE_DEPLOYMENT_PROVIDER` (those are not read by the
> code). A published build with `mock` **and** `VITE_ALLOW_MOCK_DATA=true` is the
> only sanctioned way to see fixtures; without the allow-flag a `mock` published
> build fails closed ("Portal configuration incomplete") — which is itself a valid
> Phase-2 smoke assertion.

**Prohibited env (must never be set on this project):**
`SUPABASE_SERVICE_ROLE_KEY`, `EBAY_CLIENT_SECRET`, `EBAY_REFRESH_TOKEN`,
`DATABASE_URL`, `VITE_WHATNOT_CLIENT_SECRET`, `VITE_WHATNOT_LIVE_TOKEN`, or any
secret in a `VITE_*` variable.

## Phase 3 env (after mock smoke passes — staging live)

```
VITE_BACKEND_MODE=staging
VITE_SUPABASE_URL=https://msbdwwgojuvgnuugrrry.supabase.co
VITE_EXPECTED_SUPABASE_PROJECT_REF=msbdwwgojuvgnuugrrry
VITE_SUPABASE_PUBLISHABLE_KEY=<staging publishable/anon key>   # Supabase → msbdww… → Settings → API
VITE_ANALYZE_SLAB_ENABLED=true        # optional, staging-only customer analyze gate
# server-side only (never VITE_): EBAY_CLIENT_ID / EBAY_CLIENT_SECRET / EBAY_ENVIRONMENT=sandbox / EBAY_OAUTH_SCOPES / LOVABLE_API_KEY
```
Then add the new project's `*.vercel.app` hostnames to **staging** Supabase Auth
redirect allowlist (Authentication → URL Configuration on `msbdwwgojuvgnuugrrry`).
Do **not** change production Auth URLs in this phase.

## Verification checklist (run once the project exists)
- [ ] Deployment `READY`, build log shows Node 22.x + Nitro Vercel output.
- [ ] Public pages load; protected routes enforce mock auth behavior.
- [ ] No custom/production domain attached; no connection to production Supabase.
- [ ] Browser bundle contains no secret-shaped values (`scan:secrets` + manual grep).
- [ ] Record `projectId` + first `deploymentId` back into this file and `source-of-truth.json`.

## What automation CAN do once the project exists
The frontend at `slab-scribe-pro@eadeedf9` is **proven to build for Vercel**
locally (see `05-staging-acceptance.md` build evidence). After the owner imports
the repo, redeploys/promotions and env verification can proceed here.
