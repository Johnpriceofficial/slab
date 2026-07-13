# GradedCardValue.com — Live Deployment (Operator-Run)

**You run these steps. Secrets never enter the AI conversation and are never
committed.** The scripts refuse to touch the `MCVR N8N` project or any
production-adjacent target, never echo secrets, and never enable shell tracing.

Hard-delete stays **disabled** end to end. Archival is the standard action.

---

## 1. Create a dedicated Supabase project

In the Supabase dashboard: **New project → name it `GradedCardValue`** (empty). Choose
an org, region, and a strong database password. Do **not** reuse any existing
project.

## 2. Copy the connection details locally

From **Project Settings → API** (and the DB password you just set):

- Project ref (the `xxxx` in `https://xxxx.supabase.co`)
- Project URL
- `anon` public key
- `service_role` key (used only by the local verify script to seed test users)
- Database password

## 3. Export the environment (in your terminal only — placeholders shown)

```bash
# Deploy inputs
export SLABVAULT_PROJECT_REF="<your-project-ref>"
export SLABVAULT_SUPABASE_URL="https://<your-project-ref>.supabase.co"
export SLABVAULT_ANON_KEY="<your-anon-key>"
export SLABVAULT_SERVICE_ROLE_KEY="<your-service-role-key>"
export PRICECHARTING_API_TOKEN="<your-pricecharting-token>"
export ANTHROPIC_API_KEY="<your-anthropic-key>"
# Optional: skip the secure prompt by exporting the DB password
# export SLABVAULT_DB_PASSWORD="<your-db-password>"
```

> Use real values only in your shell. Never paste them into the AI chat, a file,
> or a commit. `.env.local` is gitignored and only receives PUBLIC values.

## 4. Deploy

```bash
cd ~/Desktop/SlabVault
bash scripts/deploy-live.sh
```

This links the project, pushes all migrations, sets the two edge secrets (via a
temporary 600-mode env-file removed on exit), builds + `deno check`s both edge
bundles, and deploys `pricecharting-search` and `analyze-slab`. It writes only
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and
`VITE_ALLOW_SLAB_HARD_DELETE=false` to `.env.local`. Output is sanitized
pass/fail only. If the DB password isn't exported, you'll be prompted securely.

## 5. Verify (live integration + full gate)

```bash
export SLABVAULT_TEST_URL="https://<your-project-ref>.supabase.co"
export SLABVAULT_TEST_ANON_KEY="<your-anon-key>"
export SLABVAULT_TEST_SERVICE_KEY="<your-service-role-key>"

bash scripts/verify-live.sh
```

Required outcome: the **eight integration tests RUN (0 skipped, 0 failed)**, the
full suite passes, typecheck/build/bundles/deno checks pass, and the secret scan
is clean. The script exits non-zero if anything fails.

Expected full-suite total with the live vars set: **173 passed, 0 skipped**.

## 6. Bootstrap the human admin (one time)

Sign up once in the app at `/login` (or create a user in Auth), then in the
Supabase SQL editor:

```sql
insert into public.slab_admins (user_id)
values ('<your-auth-user-uuid>')
on conflict (user_id) do nothing;

select user_id, created_at from public.slab_admins;   -- confirm the row
```

## 7. Browser smoke test

1. Visit a protected route signed out → redirected to `/login`.
2. Sign in as a non-admin → **Access denied**; as an admin → `/dashboard` loads.
3. `/slabs/new` → upload front + back → **Analyze Images** → proposals appear;
   apply/edit (nothing auto-saves). Enter a leading-zero cert (e.g. `0012345`).
4. **Search PriceCharting** → confirm a product; add **sold comps**; **Approve as
   Final Value**; **Save**.
5. Confirm the row, both images, DB-sequence number, cert leading zero, detail
   page, prev/next, list, dashboard totals.
6. **Archive** → leaves active list (Show archived reveals it), number preserved;
   **Unarchive** to restore.
7. **Export Inventory** → 3 sheets, cert stored as text.
8. Hard-delete stays hidden/disabled (leave it that way for real inventory).

## 8. Report back for triage

Paste only **redacted** command output (the scripts already sanitize known
secrets). Do not paste keys, tokens, the service-role key, or the DB password.

---

### Safety properties built into the scripts
- Refuse unless `SLABVAULT_PROJECT_REF` is set; refuse the `MCVR N8N` ref
  (`qzkuwtvqftfppojarfij`); refuse any ref/URL containing `mcvr`, `joyrent`,
  `party`, `mycousin`, or `production`.
- Reject empty / placeholder values (`YOUR_PROJECT_REF`, `YOUR_TOKEN`,
  `changeme`, …) and surrounding whitespace; confirm the URL matches the ref.
- `set -euo pipefail`, never `set -x`, never echo secrets, secrets only via a
  trap-cleaned temp env-file, `.env.local` verified gitignored before writing.
