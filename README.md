# SlabVault

Standalone graded-Pokémon-slab inventory app. One card at a time: upload
front/back photos, verify identity, pull the **Current PriceCharting Guide
Value** from a server-side function, assign the next race-safe inventory number,
block duplicate certifications, save permanently, and export to Excel. Built for
~1,000 slabs.

Extracted from the joyrent monorepo into its own project. Vite + React + TS +
Supabase + Vitest.

## Structure

```
src/
  lib/pricecharting/   Reusable PriceCharting API client (rate limit, retries, grade mapping)
  lib/slabs/           Slab domain: types, save flow, data access, Excel, stats
  server/pricecharting/handler.ts   Framework-agnostic edge handler (token stays server-side)
  components/slabs/    Image uploader, PriceCharting panel
  components/ui/       shadcn primitives used by the app
  pages/slabs/         /dashboard, /slabs, /slabs/new, /slabs/:id
  test/                Vitest suites (117 tests: slabs + pricecharting)
supabase/
  migrations/          slabs + slab_comps + race-safe RPCs + slab-images bucket
  functions/pricecharting-search/   Deno edge function (admin-only)
  functions/_shared/pricecharting-bundle.js   Generated: node scripts/build-pricecharting-edge-bundle.mjs
scripts/build-pricecharting-edge-bundle.mjs
```

## Setup

```bash
bun install                 # or: npm install
cp .env.example .env.local  # fill VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
bun run test                # 117 tests
bun run typecheck           # 0 errors
bun run build               # production build
```

### Supabase (same commands as before)

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push                                   # applies both migrations
supabase secrets set PRICECHARTING_API_TOKEN="…"   # edge-function secret ONLY
node scripts/build-pricecharting-edge-bundle.mjs   # regenerate the edge bundle
supabase functions deploy pricecharting-search
```

## Guarantees

- Money is integer cents end-to-end; `null` never becomes `0`.
- Certification numbers are text (leading zeros preserved) in DB and Excel.
- Race-safe, gapless inventory numbers from `create_slab()` (advisory lock +
  unique constraints), never from browser state.
- PriceCharting values are labeled "Current PriceCharting Guide Value" — never
  eBay/last-sold/historical.
- `PRICECHARTING_API_TOKEN` lives only in the edge function; never in the
  client bundle, responses, logs, DB, or Excel.
- Admin-only via RLS + edge-function admin check + private `slab-images` bucket.

See `SLABVAULT.md` for the full verification report and assumptions.

## Auth note

This standalone shell renders the routes directly. Data access requires an
authenticated **admin** Supabase session (enforced by RLS + the edge function).
Wire your Supabase sign-in of choice; no login screen is bundled here (moving
the code out of the monorepo intentionally did not add new features).
