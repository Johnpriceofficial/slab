# 09 — Vercel production + DNS cutover (owner-gated interactive actions)

The production **backend** is fully promoted and verified (`08-production-promotion.md`).
The remaining steps require **interactive authenticated sessions** (Vercel login +
GitHub-app OAuth grant; Cloudflare dashboard) that automation cannot complete
without entering credentials. Per the release directive these are surfaced as
precise instructions. Nothing here has been performed.

## A. Create the Git-connected Vercel project (Step 6) — OWNER
`https://vercel.com/john-price` → **Add New → Project → Import Git Repository →
`Johnpriceofficial/slab-scribe-pro`** (authorize the Vercel GitHub app if prompted).
- Name `graded-card-value-staging`; Production branch `main`; Install `npm ci`;
  Build `npm run build`; Output **default**; **Node 22.x**; no custom domain yet.
- Do **not** touch `slab-13rc` (`prj_s3HNK69VRTNimpNMQnxxP9JyA575`).

## B. Staging deploy env (Step 7) — after import
```
VITE_BACKEND_MODE=mock          # first build: verify READY + Node22 + Nitro output, no prod calls
# then switch to live staging:
VITE_BACKEND_MODE=staging
VITE_SUPABASE_URL=https://msbdwwgojuvgnuugrrry.supabase.co
VITE_EXPECTED_SUPABASE_PROJECT_REF=msbdwwgojuvgnuugrrry
VITE_SUPABASE_PUBLISHABLE_KEY=<staging publishable key>   # Supabase → msbdww… → Settings → API
VITE_ANALYZE_SLAB_ENABLED=true
```
Add the project's `*.vercel.app` hostnames to **staging** Supabase Auth redirect
URLs. Never set `SUPABASE_SERVICE_ROLE_KEY`/`EBAY_CLIENT_SECRET`/`DATABASE_URL`/
`WHATNOT_*` in any `VITE_*`. Server-only secrets (`EBAY_*` sandbox, `LOVABLE_API_KEY`)
go in non-`VITE_` project env.

## C. Production deploy env (Step 10) — after staging passes
```
VITE_BACKEND_MODE=production
VITE_SUPABASE_URL=https://rcbwemkfcefarqnlgrmv.supabase.co
VITE_EXPECTED_SUPABASE_PROJECT_REF=rcbwemkfcefarqnlgrmv
VITE_SUPABASE_PUBLISHABLE_KEY=<production publishable key>   # Supabase → rcbwem… → Settings → API
VITE_ANALYZE_SLAB_ENABLED=false
```
`EBAY_ENVIRONMENT` stays `sandbox` (production listing mutations remain disabled).
Deploy `slab-scribe-pro/main` and test the **immutable** `*.vercel.app` URL before
attaching the domain (homepage, sign-in, session restore, protected routes,
scanner, inventory, valuation, account, admin-denial, contact, TLS, console).

## D. Domain + DNS cutover (Step 11 / Gate B) — OWNER (Cloudflare)
1. In the new Vercel project → **Domains → add** `gradedcardvalue.com` + `www.gradedcardvalue.com`.
2. **Capture current Cloudflare DNS records verbatim** (rollback baseline).
3. Lower TTL, then set the Vercel-required records (apex A/ALIAS + `www` CNAME per
   Vercel's instructions); keep apex→`www` (or chosen) redirect behavior.
4. Verify TLS issued; verify Supabase Auth **production** redirect/callback URLs
   include `https://gradedcardvalue.com` (and `www`); assets + redirects load.
5. Run production smoke tests; keep the old Cloudflare origin live through
   stabilization; **roll back DNS to the captured records** if auth/scanner/
   inventory/account flows fail.

## Automation status
- Vercel project: **not created** (interactive OAuth — owner action A).
- Vercel deploys: blocked on A.
- DNS: **not changed** (Cloudflare interactive — owner action D). No Cloudflare
  credential/MCP is available to this session.
- Once A is done, redeploys/env-verification/immutable-URL smoke tests can be
  driven from here; the frontend is proven to build for Vercel (CI green @ eadeedf9).
