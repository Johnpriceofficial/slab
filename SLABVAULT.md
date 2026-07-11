# SlabVault — Graded Pokémon Slab Inventory

A one-card-at-a-time intake workflow layered onto the existing Vite + React +
Supabase app. Upload a graded slab's front/back photos, verify its identity,
pull the **Current PriceCharting Guide Value** via a server-side function, assign
the next race-safe inventory number, block duplicate certifications, save
permanently, and export the whole inventory to Excel. Built for ~1,000 slabs.

It reuses the completed `src/lib/pricecharting/` library **unmodified**.

---

## Architecture

```
Browser (admin-only routes)                Supabase
┌───────────────────────────┐              ┌─────────────────────────────┐
│ /dashboard  /slabs        │  invoke      │ Edge Fn: pricecharting-search│
│ /slabs/new  /slabs/:id    │────────────► │  ├─ isCallerAdmin (JWT)      │
│                           │              │  ├─ reads PRICECHARTING_API_ │
│ src/lib/slabs/*           │              │  │   TOKEN (server-only)     │
│  ├─ save-slab (DI flow)   │              │  └─ _shared/pricecharting-   │
│  ├─ data (supabase RPC/   │  rpc/storage │      bundle.js (bundled      │
│  │   storage/invoke)      │◄────────────►│      handler + library)      │
│  ├─ excel (exceljs, lazy) │              │ Postgres: slabs, slab_comps  │
│  └─ compute-stats         │              │  ├─ create_slab() atomic RPC │
└───────────────────────────┘              │  └─ RLS admin-only           │
                                           │ Storage: slab-images (private)│
                                           └─────────────────────────────┘
```

The PriceCharting token lives **only** in the edge-function environment. The
browser sends card identity fields; it never sees the token, and the token never
appears in responses, logs, DB rows, or the Excel export.

---

## Setup

### 1. Apply migrations
```
supabase db push          # or: supabase migration up
```
Creates `public.slabs`, `public.slab_comps`, the race-safe
`create_slab` / `next_slab_inventory_number` / `check_slab_certification`
functions, admin RLS, and the private `slab-images` storage bucket.

### 2. Set the edge-function secret (server-side only)
```
supabase secrets set PRICECHARTING_API_TOKEN="your-pricecharting-token"
```
> **Never** use a `VITE_` prefix for this — that would expose it in the browser
> bundle. It is read via `Deno.env.get("PRICECHARTING_API_TOKEN")` in the edge
> function only. Requires a paid PriceCharting API subscription.

### 3. Build the edge bundle & deploy the function
```
node scripts/build-pricecharting-edge-bundle.mjs   # regenerate when the handler/library changes
supabase functions deploy pricecharting-search
```

### 4. Run the app
```
bun run dev
```
Sign in as an admin, then open **`/dashboard`** or **`/slabs/new`**.

### Required environment variables
| Name | Where | Purpose |
|---|---|---|
| `PRICECHARTING_API_TOKEN` | Edge function secret (server) | PriceCharting auth — never client-exposed |
| `VITE_SUPABASE_URL` | Client (existing) | Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Client (existing) | Supabase anon key |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | Edge (existing) | Admin JWT verification |

---

## Run tests / typecheck / build
```
bun run test -- src/test/slabs src/test/pricecharting   # 117 tests
bunx tsc --noEmit -p tsconfig.app.json                  # slab/pricecharting code is clean
bun run build                                           # production build succeeds
```

---

## Race-safe numbering & duplicate guard

`create_slab(p, front_ext, back_ext)` runs under a transaction-scoped advisory
lock: it re-checks the certification, computes `max(inventory_number)+1`, and
inserts atomically — so numbers are sequential/gapless and duplicate
certifications are impossible even under concurrent saves. A `UNIQUE` constraint
on both `inventory_number` and `certification_number` is the final backstop.

**Save order:** the row is created (with its number + deterministic image paths)
first, then both images upload to `slabs/{n}/front|back.{ext}`. If any upload
fails, the row and any uploaded object are removed (compensating cleanup), so no
incomplete inventory record ever persists. If the insert itself fails (e.g. a
duplicate certification), nothing was uploaded — there is nothing to clean up.

---

## Exact file list (added/changed)

**Database & storage**
- `supabase/migrations/20260710000000_slab_inventory.sql`
- `supabase/migrations/20260710000001_slab_images_storage.sql`

**Server-side PriceCharting**
- `src/server/pricecharting/handler.ts` (framework-agnostic, DI, tested)
- `scripts/build-pricecharting-edge-bundle.mjs`
- `supabase/functions/_shared/pricecharting-bundle.js` (generated)
- `supabase/functions/pricecharting-search/index.ts`
- `supabase/config.toml` (added `[functions.pricecharting-search]`)

**Frontend data layer** (`src/lib/slabs/`)
- `types.ts`, `constants.ts`, `format.ts`, `compute-stats.ts`
- `save-slab.ts` (DI save flow), `data.ts` (Supabase-backed), `excel.ts`
- `SLABVAULT.md` (this doc)

**Components / pages**
- `src/components/slabs/ImageUploader.tsx`
- `src/components/slabs/PriceChartingPanel.tsx`
- `src/pages/slabs/NewSlab.tsx` (`/slabs/new`)
- `src/pages/slabs/SlabList.tsx` (`/slabs`)
- `src/pages/slabs/SlabDetail.tsx` (`/slabs/:id`)
- `src/pages/slabs/SlabDashboard.tsx` (`/dashboard`)
- `src/App.tsx` (routes), `.env.template` (token note), `package.json` (exceljs)

**Tests** (`src/test/slabs/`)
- `helpers.ts`, `save-slab.test.ts`, `handler.test.ts`, `excel.test.ts`,
  `format-stats.test.ts`

---

## Verification report

**Tests — 117/117 pass** (`src/test/slabs` 37 + `src/test/pricecharting` 80):
duplicate certification rejection, leading-zero preservation, sequential
numbering, concurrent creation, low-confidence confirmation, conflicting
card-number rejection, token-never-in-responses/logs, image-upload cleanup,
DB-failure cleanup, currency conversion, Excel column order, Excel text certs,
summary totals, empty export, 1,000-record export.

**Typecheck:** slab / server / pricecharting code has **0 errors**. The repo has
21 pre-existing `tsc` errors in `src/pages/admin/AdminProductDetail.tsx`
(stale generated `types.ts` vs already-committed product migrations) — identical
count with and without this work; none introduced here.

**Production build:** succeeds. `exceljs` is lazy-loaded into its own chunk
(only fetched on export); slab pages are individually code-split.

**Full test suite:** 42 pre-existing failures across 7 `seo`/`ers`/`security`
doc-evidence files — verified identical on a clean tree (stash) with none of this
work applied. This integration adds zero new failures.

**Scope honored:** no marketplace selling, refunds, shipping, offer publishing,
buyer addresses, or feedback surfaces are exposed in the UI. The `slab-images`
bucket is private; images render via short-lived signed URLs.

### Unresolved assumptions
1. **PriceCharting sales volume** is read from a `sales-volume`/`sale-volume`
   field on the product payload if present; if the subscription tier omits it,
   `pricecharting_sales_volume` is `null` (never fabricated).
2. **`duplicate_status`** powers the dashboard "duplicate attempts" count; blocked
   duplicates never become rows, so this counts slabs an operator explicitly
   flagged (`duplicate_attempt`/`confirmed_duplicate`).
3. **Admin-only:** slab routes use `requireAdmin` and RLS/RPCs enforce
   `is_admin(auth.uid())`. Change the policies if a non-admin operator role is
   later required.
4. Migrations and the edge function are authored and verified but not applied to
   a live project in this environment; run the setup steps above to deploy.
