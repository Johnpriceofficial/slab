# SlabVault — Deployment Runbook (dedicated Supabase project)

You run these; they need your DB password + real PriceCharting token + Anthropic
key (secrets I never see). Everything targets a **new, empty** project.

---

## 0. Create the dedicated project

1. https://supabase.com/dashboard → **New project** → name it `SlabVault`.
2. Copy from **Project Settings → API**:
   - Project URL  → `VITE_SUPABASE_URL`
   - `anon` public key → `VITE_SUPABASE_ANON_KEY`
   - Reference ID (the `xxxx` in the URL) → `PROJECT_REF` below
3. Copy the database password you set at creation (Project Settings → Database).

## 1. Frontend env

```bash
cd ~/Desktop/SlabVault
cp .env.example .env.local
# edit .env.local:
#   VITE_SUPABASE_URL=https://<PROJECT_REF>.supabase.co
#   VITE_SUPABASE_ANON_KEY=<anon key>
```

## 2. The commands

```bash
cd ~/Desktop/SlabVault

# (1) link the CLI to the new project (prompts for the DB password)
supabase link --project-ref <PROJECT_REF>

# (2) apply all 9 migrations in order (admin → tables → storage →
#     cert-normalization → constraints → rate-limits → archive →
#     inventory-seq → hard-delete-guard)
supabase db push

# (3) set edge-function SECRETS only (never a VITE_ prefix)
supabase secrets set PRICECHARTING_API_TOKEN="<your real PriceCharting token>"
supabase secrets set ANTHROPIC_API_KEY="<your Anthropic key>"   # for analyze-slab
# optional: supabase secrets set ANALYZE_MODEL="claude-sonnet-5"

# (4) regenerate the Deno bundles the edge functions import
node scripts/build-pricecharting-edge-bundle.mjs
node scripts/build-analyze-slab-edge-bundle.mjs

# (5) deploy the admin-only edge functions
supabase functions deploy pricecharting-search
supabase functions deploy analyze-slab
```

## 3. Bootstrap yourself as admin (one time)

Until you're in `slab_admins`, RLS blocks everything (intentional). Sign in to
the app at `/login` once (or create a user in Auth), then in the SQL editor:

```sql
select id, email from auth.users;                       -- find your id
insert into public.slab_admins (user_id) values ('<your-user-id>');
```

## 4. Run the app

```bash
bun run dev    # http://localhost:5173  → /login, then /dashboard
```

---

## Verification queries (run in the Supabase SQL editor)

```sql
-- Tables present
select table_name from information_schema.tables
where table_schema='public'
  and table_name in ('slabs','slab_comps','slab_admins','api_rate_limits','slab_settings')
order by table_name;                       -- expect 5 rows

-- Functions present
select routine_name from information_schema.routines
where routine_schema='public'
  and routine_name in ('create_slab','check_slab_certification','is_admin',
                       'slab_set_updated_at','normalize_cert','normalize_grader',
                       'valid_image_ext','reserve_api_request_slot',
                       'archive_slab','unarchive_slab','hard_delete_slab')
order by routine_name;                     -- expect 11 rows

-- Inventory-number unique constraint (the global cert unique was replaced by a
-- grader-scoped composite unique INDEX, below — not a constraint)
select conname from pg_constraint
where conrelid='public.slabs'::regclass and contype='u';   -- expect 1 (inventory_number)

-- Grader-scoped composite unique index on normalized (grader, cert)
select indexname from pg_indexes
where schemaname='public' and tablename='slabs'
  and indexname='slabs_grader_cert_normalized_uidx';        -- expect 1 row

-- Inventory sequence exists
select sequencename from pg_sequences
where schemaname='public' and sequencename='slab_inventory_seq';  -- expect 1 row

-- NOT NULL identity columns
select column_name from information_schema.columns
where table_schema='public' and table_name='slabs' and is_nullable='NO'
  and column_name in ('card_name','grader','grade','certification_number','verification_status')
order by column_name;                                       -- expect 5 rows

-- RLS enabled on all tables
select relname, relrowsecurity from pg_class
where relname in ('slabs','slab_comps','slab_admins','api_rate_limits');  -- true

-- Storage bucket (private, 15 MB, image mimes) — unchanged
select id, public, file_size_limit, allowed_mime_types
from storage.buckets where id='slab-images';               -- public = false
```

## Duplicate / constraint proof (DB level)

```sql
-- A complete row succeeds; a same-grader normalized-duplicate cert fails; a
-- different grader with the same cert SUCCEEDS (grader-scoped). Then clean up.
-- (Direct inserts must satisfy NOT NULL identity columns.)
insert into public.slabs (inventory_number, card_name, grader, grade, certification_number)
  values (999999, 'Test', 'PSA', '10', '00123');
insert into public.slabs (inventory_number, card_name, grader, grade, certification_number)
  values (999998, 'Test', 'PSA', '10', ' 00 123 ');  -- ERROR: normalized dup within PSA
insert into public.slabs (inventory_number, card_name, grader, grade, certification_number)
  values (999997, 'Test', 'CGC', '10', '00123');     -- OK: different grader
delete from public.slabs where inventory_number in (999999, 999998, 999997);

-- Durable rate-limit spacing: two reservations are ≥1s apart.
select public.reserve_api_request_slot('demo', 1000) as a,
       public.reserve_api_request_slot('demo', 1000) as b;   -- b - a >= 1 second
delete from public.api_rate_limits where bucket='demo';
```

Real concurrency (two callers → distinct sequence numbers, no duplicate) is
exercised by the app save flow, `src/test/slabs/save-slab.test.ts`, and the live
integration tests in `src/test/integration/`.

## Live smoke checklist (in the app, after bootstrap)

1. Visit a protected route while signed out → redirected to `/login`. Sign in as
   a non-admin → **Access denied**. Sign in as an admin → `/dashboard` loads.
2. `/slabs/new` → upload front + back → **Analyze Images** → review proposals,
   apply, and edit. Enter a **cert with a leading zero** (e.g. `0012345`).
3. Duplicate check runs (grader-scoped); **Search PriceCharting** → confirm a
   product; add **sold comps**; **Approve as Final Value**; **Save**.
4. Confirm: row + both images in `slab-images/slabs/{n}/`, number from the DB
   sequence, cert kept its leading zero, detail loads, prev/next work, appears in
   `/slabs`, `/dashboard` totals update.
5. **Archive** the slab → it leaves the active list (Show archived reveals it),
   number preserved. **Unarchive** to restore.
6. **Export Inventory** → 3 sheets, exact column order, cert stored as text,
   currency cells, frozen header, filters.
7. **Archive** is the standard action. Hard delete is double-gated: the RPC
   refuses with `HARD_DELETE_DISABLED` until `update public.slab_settings set
   allow_hard_delete = true`, and the UI button is hidden in prod builds unless
   `VITE_ALLOW_SLAB_HARD_DELETE=true`. With both enabled → row + comps + images
   removed; leave `allow_hard_delete=false` for real inventory.

## Security model (consistent across layers)

- **Frontend guard** — `AuthProvider` + `ProtectedAdminRoute` gate every
  protected route on a confirmed admin (`is_admin(auth.uid())`).
- **Admin = a row in `public.slab_admins`.**
- **RLS** on `slabs` / `slab_comps` / `slab_admins` / `api_rate_limits`.
- **Storage** `slab-images`: private; all object ops require `is_admin`; served
  via short-lived signed URLs.
- **Edge functions** `pricecharting-search` + `analyze-slab`: `verify_jwt=true`
  + `isCallerAdmin`. Secrets read only from the function env.
- Anon users: blocked at every layer.
```
