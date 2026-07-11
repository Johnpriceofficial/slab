# SlabVault — Deployment Runbook (dedicated Supabase project)

You run these; they need your DB password + real PriceCharting token (secrets I
never see). Everything is additive to a **new, empty** project.

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

## 2. The 5 commands

```bash
cd ~/Desktop/SlabVault

# (1) link the CLI to the new project (prompts for the DB password)
supabase link --project-ref <PROJECT_REF>

# (2) apply all three migrations in order (admin model → tables → storage)
supabase db push

# (3) set the PriceCharting token as an EDGE-FUNCTION SECRET only (never VITE_)
supabase secrets set PRICECHARTING_API_TOKEN="<your real PriceCharting token>"

# (4) regenerate the Deno bundle the edge function imports
node scripts/build-pricecharting-edge-bundle.mjs

# (5) deploy the admin-only edge function
supabase functions deploy pricecharting-search
```

## 3. Bootstrap yourself as admin (one time)

Until you're in `slab_admins`, RLS blocks everything (intentional). Sign in to
the app once (or create a user in Auth), then in the SQL editor:

```sql
select id, email from auth.users;                       -- find your id
insert into public.slab_admins (user_id) values ('<your-user-id>');
```

## 4. Run the app

```bash
bun run dev    # http://localhost:5173  → redirects to /dashboard
```

---

## Verification queries (run in the Supabase SQL editor)

```sql
-- Tables present
select table_name from information_schema.tables
where table_schema='public' and table_name in ('slabs','slab_comps','slab_admins')
order by table_name;                       -- expect 3 rows

-- Functions present
select routine_name from information_schema.routines
where routine_schema='public'
  and routine_name in ('create_slab','next_slab_inventory_number',
                       'check_slab_certification','is_admin','slab_set_updated_at')
order by routine_name;                     -- expect 5 rows

-- Unique constraints on slabs (inventory_number + certification_number)
select conname from pg_constraint
where conrelid='public.slabs'::regclass and contype='u';   -- expect 2

-- Indexes on slabs
select indexname from pg_indexes where schemaname='public' and tablename='slabs';

-- RLS enabled on all three tables
select relname, relrowsecurity from pg_class
where relname in ('slabs','slab_comps','slab_admins');     -- relrowsecurity = true

-- Policies
select tablename, policyname from pg_policies
where tablename in ('slabs','slab_comps','slab_admins')
order by tablename;

-- updated_at trigger
select tgname from pg_trigger
where tgrelid='public.slabs'::regclass and not tgisinternal;  -- slabs_set_updated_at

-- Storage bucket (private, 15 MB, image mimes)
select id, public, file_size_limit, allowed_mime_types
from storage.buckets where id='slab-images';               -- public = false

-- Storage policies
select policyname from pg_policies
where schemaname='storage' and tablename='objects'
  and policyname like 'slab-images%';                       -- expect 4
```

## Race-safe / duplicate guard proof (DB level)

```sql
-- Should SUCCEED, then FAIL twice on the unique guards, then clean up.
insert into public.slabs (inventory_number, certification_number) values (999999, 'TESTDUP');
insert into public.slabs (inventory_number, certification_number) values (999998, 'TESTDUP'); -- ERROR: duplicate certification_number
insert into public.slabs (inventory_number, certification_number) values (999999, 'TESTX');   -- ERROR: duplicate inventory_number
delete from public.slabs where certification_number in ('TESTDUP','TESTX');
```

Real concurrency (two callers → distinct sequential numbers, no duplicate) is
exercised by the app's save flow and by `src/test/slabs/save-slab.test.ts`
("gives concurrent creations distinct sequential numbers"). At the DB level the
guarantee comes from the transaction advisory lock in `create_slab` plus the two
unique constraints above.

## Live smoke checklist (in the app, after bootstrap)

1. `/slabs/new` → upload front + back, enter identity, **cert with a leading
   zero** (e.g. `0012345`).
2. Type the cert → duplicate check runs; **Search PriceCharting** → candidates
   with confidence; **confirm** a product; enter Final Value; **Save**.
3. Confirm: row exists, both images exist in `slab-images/slabs/{n}/`, the
   number came from the DB, the cert kept its leading zero, detail page loads,
   prev/next work, it appears in `/slabs`, `/dashboard` totals update.
4. **Export Inventory** → open the `.xlsx`: 3 sheets, exact column order, cert
   stored as text (leading zero intact), currency cells, frozen header, filters.
5. Delete the temporary slab + its images when done.

## Security model (consistent across layers)

- **Admin = a row in `public.slab_admins`.** `public.is_admin(uuid)` checks it.
- **RLS** on `slabs` / `slab_comps` / `slab_admins`: all ops require
  `is_admin(auth.uid())`.
- **Storage** `slab-images`: private bucket; all object ops require
  `is_admin(auth.uid())`; images served via short-lived signed URLs.
- **Edge function** `pricecharting-search`: `verify_jwt=true` + `isCallerAdmin`
  (calls the same `is_admin` RPC). The token is read only from the function env.
- Anon users: blocked at every layer.
```
