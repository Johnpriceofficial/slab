# Graded Card Value — consolidated remediation plan

**Date:** 2026-07-31
**Reconciles:** the infrastructure "Deep audit result" (GitHub/Lovable/Vercel/Supabase)
against the live-verified security re-audit performed the same day.
**Nature:** planning document. Every production change below is **owner-applied**.
Read-only diagnostics and repo drafts were done by the agent; nothing here has been
deployed, published, applied to production, or merged.

---

## 0. Reconciled verdict

Two things are simultaneously true, and they are different categories:

- **Data-layer security is solid** (independently re-verified live, 2026-07-31):
  no privilege-escalation path (customer JWT cannot write `slab_admins`/`user_roles`,
  cannot flip `allow_hard_delete`, cannot forge `audit_log`); RLS enabled on **all 62
  tables**; **all 62 SECURITY DEFINER functions** pin `search_path` and none are
  anon/public-executable; JWT forgery (alg:none, bad-sig) → 401; no open-redirect;
  storage + cross-tenant reads return owner-only/empty; 120-way concurrency → 0 5xx.
  `is_admin()` reads only server-controlled `auth.users.raw_app_meta_data`.

- **Release-integrity and infrastructure are NOT clean.** The infra audit is correct
  on four confirmed findings (below). These are provenance, architecture and
  least-privilege issues — not data-breach issues — but they are real launch blockers.

**"Production-ready" applies to the data layer, not the release/infra layer.**

---

## 1. Findings — confirmed against live data

| # | Finding | Severity | Confirmed | Owner/agent |
|---|---|---|---|---|
| F3 | Public Vercel shadow (`slab-13rc`) built from the **backend** repo, connected to **prod** Supabase | **P0** architecture / attack-surface | ✅ | owner (Vercel) |
| F4 | Migration ledger ≠ contract (67/`20260904` vs 69/`20260908`) → `MIGRATIONS_FAILED` | **P1** operational integrity | ✅ | owner (Supabase CLI) |
| F5 | Admin authority split across `app_metadata` / `user_roles` / `slab_admins`; owner `has_role('administrator')=false` | **P1** authz consistency | ✅ | owner (decision) + agent (draft) |
| F6 | `anon`/`authenticated` hold `TRUNCATE/REFERENCES/TRIGGER` on authz tables | **P1** least-privilege | ✅ | **agent drafted → PR #94**; owner applies |
| G1 | PR #8 (Lovable remediation, 693 files) CI never ran (`action_required`) | **P0 for PR #8** | ✅ (PR #8 is a separate workstream) | owner |
| G2 | `test:db:backend-patches` not a required hosted CI job | P1 release-gate | plausible | owner (CI) |
| G3 | Leaked-password protection disabled | P2 | ✅ (advisor) | owner (Auth toggle) |
| G4 | Role-lookup RPCs accept arbitrary `user_id` (enumeration) | P2 | ✅ | agent (draft) + owner |
| G5 | Duplicate push+PR CI runs; main-branch protection unconfirmed | P2 | plausible | owner (CI/settings) |
| G6 | Perf debt: unindexed FKs, RLS init-plan re-eval, multiple permissive policies, fixed Auth conn pool; large Vercel chunks | P2/P3 | ✅ (advisors) | owner + agent (indexes) |

**Correction to the infra audit:** `/admin` is **not** an open leak — it redirects to
sign-in for anonymous users on both Lovable *and* the Vercel shadow (gating is
client-side; the raw 200 is just the SPA shell). And **PR #8 ≠ the contract PRs #7/#93**
that were merged green (13/13 CI, 1265 tests); the "workflows never ran" concern is
specific to PR #8.

---

## 2. Per-finding remediation

### F3 — Vercel shadow `slab-13rc` (P0) — OWNER
**Root cause:** the backend repo `Johnpriceofficial/slab` contains a full Vite/React
frontend (`index.html`, `src/App.tsx`, `src/pages`, `vercel.json`). Vercel project
`slab-13rc` (`prj_s3HNK69VRTNimpNMQnxxP9JyA575`, team `john-price`) is git-connected to
that repo and auto-deploys on **every push to `main` and every PR branch**. `vercel.json`
hardcodes `connect-src https://rcbwemkfcefarqnlgrmv.supabase.co` and rewrites
`/api/scan-card` → the prod edge function. Public aliases: `slab-13rc.vercel.app`,
`slab-13rc-john-price.vercel.app`, `slab-13rc-git-main-john-price.vercel.app`. No
`gradedcardvalue.com` binding (canonical host is Lovable). Latest prod deploy =
`main@c65d438`. It is a *different, older* bundle (hCaptcha auth) than canonical.

**Immediate (minutes):** Vercel → `slab-13rc` → Settings → **Deployment Protection** →
enable **Vercel Authentication** for all environments. This makes every alias require
Vercel login — the public surface closes instantly without deleting anything.

**Then (deliberate):**
1. Settings → **Git** → disconnect `Johnpriceofficial/slab` (stops backend pushes from
   auto-deploying a frontend), **or** set Production Branch to a disabled value and add
   an Ignored Build Step.
2. Decide the project's purpose: since Lovable is canonical, either **delete** `slab-13rc`
   or **repurpose** it against the canonical frontend repo + `gradedcardvalue.com` — an
   explicit architecture decision, not a silent repoint.
3. Repo-level follow-up (agent can draft on request): remove the embedded frontend from
   the backend repo, or split it, so there is one source of truth. Not drafted here
   because it is invasive and needs your decision on whether the backend-repo frontend
   is still wanted.

*Constraint honored: the Vercel project was NOT modified or removed.*

### F4 — Migration ledger (P1) — OWNER
Full manifest: `release/evidence/migration-ledger-reconciliation.md`. Summary: launch
schema is applied and live; canonical `20260907/20260908` are recorded under out-of-band
`20260729131106/131134`; `20260905` is applied-unrecorded; `20260906` (account deletion)
is absent. Reconcile with `supabase migration repair --status applied 20260905000000
20260907000000 20260908000000` (and decide `20260906`) — **do not** hand-edit rows or
re-run applied migrations. Apply PR #94 only after this.

### F5 — Admin authority unification (P1) — OWNER decision + agent draft
Live status:

| Account | `is_admin` (app_meta) | `has_role('administrator')` | `slab_admins` |
|---|---|---|---|
| owner `info@johnpricebookings.com` | ✅ | ❌ | ✅ |
| test+admin | ✅ | ✅ | ❌ |

Any guard keyed on `has_role('administrator')` (the audit says eBay functions do) rejects
the owner. The `app_role` enum also has redundant `administrator` **and** `admin`.

**Recommendation — pick ONE canonical source and route every guard through it.** Two viable options:

- **Option A (recommended, lowest-risk now): `is_admin()` / app-metadata is canonical.**
  It is already the launch source, is server-controlled and ungameable, and *both* admins
  already have the flag. Action: change the `has_role('administrator')`-based guards (eBay
  server code) to call `is_admin(auth.uid())`; treat `user_roles`/`slab_admins` as
  deprecated (or keep `slab_admins` as an admin-managed display list only). Collapse the
  enum to a single `admin` value.
- **Option B (audit's rec): `user_roles` is canonical.** More auditable, but requires
  backfilling every admin into `user_roles` (owner is missing), rewiring `is_admin()` to
  read `user_roles`, and keeping it in sync. Higher blast radius.

Because eBay (the main `has_role` consumer) is disabled this launch, this is not a launch
blocker for the analyze/save flow, but it must be resolved before eBay or any role-guarded
feature ships. Agent can draft the chosen migration + guard changes on request.

### F6 — Least-privilege grants (P1) — DRAFTED → PR #94, owner applies
`REVOKE TRUNCATE/REFERENCES/TRIGGER` from client roles on `slab_admins`/`user_roles`,
keep RLS-gated `SELECT`/DML. Draft migration `20260909000000_least_privilege_authz_tables.sql`
in **PR #94** (draft; apply after F4). Verify on staging that the admin UI still edits
`slab_admins` and customers still read their own `user_roles` row.

**Open decision (stricter option):** does the admin UI edit the admin list via direct
`authenticated` DML, or via a service-role/edge path? If the latter, `authenticated`
`INSERT/UPDATE/DELETE` on `slab_admins` can *also* be revoked as pure defence-in-depth
(RLS already blocks non-admins). Confirm the admin UI's write path on staging first;
PR #94 keeps DML by default so it cannot break the admin UI — tighten only if verified
unused. This also interacts with F5: if `slab_admins` is deprecated in favour of a single
canonical admin source, its client DML grant can be dropped outright.

### G2 — hosted DB tests in the release gate (P1) — OWNER (CI)
Add a Postgres-service job that runs `npm run test:db:backend-patches` and add it to
`release-gate.needs` so the highest-risk DB fixes can't regress silently.

### G3 — leaked-password protection (P2) — OWNER
Supabase → Auth → Providers/Policies → enable "Leaked password protection" (HaveIBeenPwned).

### G4 — role-enumeration hardening (P2) — agent draft + owner
Add self-scoped helpers so the browser never passes an arbitrary `user_id`:
```sql
create or replace function public.is_current_user_admin() returns boolean
  language sql stable security definer set search_path to 'public','auth'
  as $$ select public.is_admin(auth.uid()) $$;
revoke all on function public.is_current_user_admin() from public, anon;
grant execute on function public.is_current_user_admin() to authenticated;
```
Then migrate frontend callers off `is_admin(uid)`/`has_role(uid,role)` and restrict the
arbitrary-uid variants' EXECUTE to service/admin contexts. Additive; agent can draft.

### G5 — CI trigger + branch protection (P2) — OWNER
- Change workflow trigger to avoid double runs:
  ```yaml
  on:
    push: { branches: [main] }
    pull_request:
  ```
- Confirm `main` protection: require PR + the release-gate + the DB-test check + ≥1
  approval; dismiss stale approvals; block force-push/deletion; require conversation
  resolution.

### G6 — performance debt (P2/P3) — owner + agent
Add covering indexes for the INFO-listed unindexed FKs (agent can draft a migration);
consolidate the double `slabs` SELECT policies; wrap per-row `auth.*` calls in
`(select auth.uid())` in RLS quals (many already are); switch Auth to percentage-based
connection allocation; dynamic-import the Excel (942 KB) and HEIC (1.35 MB) chunks in the
frontend that owns them.

---

## 3. Suggested order (safe)

1. **F3 immediate:** enable Vercel Deployment Protection on `slab-13rc` (closes the public
   shadow in minutes).
2. **F4:** reconcile the migration ledger (`supabase migration repair …`); decide `20260906`.
3. **F6:** review + apply PR #94 (after F4) on staging → prod.
4. **F5:** choose the canonical admin source; agent drafts the migration + guard changes.
5. **G2/G5:** add the DB-test job to the release gate; fix the CI trigger; confirm branch protection.
6. **PR #8:** approve its workflows, let hosted CI run on the final head, fresh review, then merge — **separate from the already-merged #7/#93.**
7. **G3/G4/G6:** leaked-password toggle, self-scoped role helpers, perf/index cleanup.

## 4. Owner vs agent split

- **Agent already did (read-only / drafts):** migration manifest (`migration-ledger-reconciliation.md`),
  Vercel characterization (this doc), grant-hardening draft **PR #94**, this plan.
- **Agent can still draft on request:** F5 migration + guard edits (once you pick A/B),
  G4 self-scoped helpers, G6 index migration, backend-frontend split.
- **Owner-only (production / infra / decisions):** Vercel protection/disconnect/delete,
  `supabase migration repair`, applying any migration, Auth toggles, CI/branch-protection
  settings, PR merges/approvals, the F5 canonical-source decision.
