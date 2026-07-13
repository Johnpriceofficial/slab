# GradedCardValue.com — Graded Card Inventory & Valuation

A one-card-at-a-time intake workflow on a standalone Vite + React + Supabase app.
Sign in as an admin, upload a graded slab's front/back photos, optionally
**analyze** them with AI to propose an identity (which you confirm/edit), pull the
**Current PriceCharting Guide Value** via a server-side function, record **sold
comps**, get an operator-approved **Final Value**, assign a permanent inventory
number, block grader-scoped duplicate certifications, and export the inventory to
Excel. Built for ~1,000 slabs.

It reuses the completed `src/lib/pricecharting/` library **unmodified**.

---

## Architecture

```
Browser (admin-only routes, guarded)        Supabase
┌───────────────────────────┐              ┌──────────────────────────────────┐
│ /login (public)           │              │ Edge Fn: pricecharting-search     │
│ AuthProvider + guard       │  invoke      │  ├─ isCallerAdmin (JWT)           │
│ /dashboard /slabs          │────────────► │  ├─ reserve_api_request_slot RPC  │
│ /slabs/new /slabs/:id      │              │  │   (durable 1 req/s)            │
│                            │              │  ├─ PRICECHARTING_API_TOKEN (env) │
│ src/lib/slabs/*            │              │  └─ pricecharting-bundle.js        │
│  ├─ save-slab (DI flow)    │  rpc/storage │ Edge Fn: analyze-slab             │
│  ├─ comps (stats/valuation)│◄────────────►│  ├─ isCallerAdmin (JWT)           │
│  ├─ data (rpc/storage/     │              │  ├─ ANTHROPIC_API_KEY (env)       │
│  │   invoke)               │              │  └─ analyze-slab-bundle.js        │
│  └─ excel (exceljs, lazy)  │              │ Postgres: slabs, slab_comps,      │
└───────────────────────────┘              │   api_rate_limits                  │
                                           │  ├─ create_slab() (seq numbering)  │
                                           │  ├─ check_slab_certification()     │
                                           │  ├─ archive/unarchive/hard_delete  │
                                           │  └─ RLS admin-only                 │
                                           │ Storage: slab-images (private)     │
                                           └──────────────────────────────────┘
```

Neither secret ever reaches the browser: the PriceCharting token and the
Anthropic key live **only** in their edge-function environments. The browser
sends card fields / image bytes; it never sees a key, and keys never appear in
responses, logs, DB rows, or the Excel export.

---

## Security model (defense in depth)

1. **Frontend** — `AuthProvider` reads the session, subscribes to auth changes,
   and verifies `is_admin(auth.uid())`. `ProtectedAdminRoute` renders protected
   pages only for a confirmed admin; unauthenticated users are redirected to
   `/login`, authenticated non-admins see an explicit Access Denied page.
2. **Database** — RLS restricts every table to `is_admin`; `create_slab` and the
   archive/delete RPCs are `SECURITY DEFINER` and re-check admin.
3. **Edge functions** — both re-verify the caller's JWT via `isCallerAdmin`.

The frontend guard is additive; the DB + edge checks remain authoritative.

---

## Setup

### 1. Apply migrations
```
supabase db push          # or: supabase migration up
```
Creates `public.slabs`, `public.slab_comps`, `public.api_rate_limits`; the
`create_slab` / `check_slab_certification` / `reserve_api_request_slot` /
`archive_slab` / `unarchive_slab` / `hard_delete_slab` functions; normalized
certification columns + composite unique; identity constraints; the inventory
sequence; admin RLS; and the private `slab-images` bucket. (Migrations live in
`supabase/migrations/`.)

### 2. Bootstrap the first admin
```
-- after you sign up in the app / dashboard:
select id, email from auth.users;
insert into public.slab_admins (user_id) values ('<your-user-id>');
```
Until a row exists, no one can read or write slabs — that is intentional.

### 3. Set edge-function secrets (server-side only)
```
supabase secrets set PRICECHARTING_API_TOKEN="your-pricecharting-token"
supabase secrets set ANTHROPIC_API_KEY="your-anthropic-key"   # for analyze-slab
# optional: ANALYZE_MODEL (defaults to claude-sonnet-5)
```
> **Never** use a `VITE_` prefix for these — that would expose them in the
> browser bundle. They are read via `Deno.env.get(...)` in the edge functions.

### 4. Build the edge bundles & deploy the functions
```
node scripts/build-pricecharting-edge-bundle.mjs
node scripts/build-analyze-slab-edge-bundle.mjs
supabase functions deploy pricecharting-search
supabase functions deploy analyze-slab
```

### 5. Run the app
```
bun run dev
```
Sign in at **`/login`**, then open **`/dashboard`** or **`/slabs/new`**.

### Required environment variables
| Name | Where | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | Client (`.env.local`) | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Client (`.env.local`) | Supabase anon (public) key |
| `PRICECHARTING_API_TOKEN` | Edge secret (server) | PriceCharting auth — never client-exposed |
| `ANTHROPIC_API_KEY` | Edge secret (server) | analyze-slab vision model — never client-exposed |
| `ANALYZE_MODEL` | Edge secret (optional) | Override the analysis model id |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | Edge (auto) | JWT verification + service-role RPCs |

---

## Run tests / typecheck / build
```
bun run test          # 378 tests (367 pass; 11 env-gated live integration skipped)
bun run typecheck     # 0 errors
bun run build         # production build succeeds
```

---

## Inventory numbering & duplicate guard

`create_slab(p, front_ext, back_ext)` validates image extensions, runs a
grader-scoped **normalized** duplicate check under a transaction advisory lock
(so a duplicate raises a friendly error with the existing number), then allocates
a number from a monotonic **sequence** (`slab_inventory_seq`) and inserts.

- **Numbers are permanent and never reused.** A deleted/archived number is never
  reissued. Gaps from failed transactions (rejected duplicate, rolled-back upload,
  hard-deleted test record) are acceptable and expected — **not** claimed gapless.
- **Duplicates are grader-scoped:** a certification is unique within a grading
  company, matched on normalized `(grader, certification_number)` (whitespace
  stripped, uppercased, leading zeros preserved). The displayed cert text is
  stored verbatim. A partial composite `UNIQUE` index is the final backstop.

**Save order:** the row is created (with its number + deterministic image paths)
first, then both images upload to `slabs/{n}/front|back.{ext}`. If any upload
fails, the row and any uploaded object are removed (compensating cleanup).

---

## Archival vs deletion

Real inventory is **archived** (`archive_slab`) — hidden from active inventory but
number, comps, images, and history preserved; reversible via `unarchive_slab`. A
separate, explicitly-confirmed **hard delete** (`hard_delete_slab`) exists only
for temporary test records; it removes comps + both images + the row and reports
partial cleanup failures.

Hard delete is **double-gated** so it can't be used casually in production:
- **Server-side (authoritative):** `hard_delete_slab` raises `HARD_DELETE_DISABLED`
  unless an admin sets `public.slab_settings.allow_hard_delete = true`. A direct
  RPC call is blocked regardless of the UI.
- **Client-side (defense in depth):** the "Delete test record" button is hidden in
  production builds unless `VITE_ALLOW_SLAB_HARD_DELETE=true`.

Archival is the standard action and is always available.

---

## Sales comps & valuation

`slab_comps` supports full CRUD from the slab detail page. Derived stats:
exact-comp count + median, accepted median, sold range, most-recent sale. A
suggested **Final Value** follows exact-median → accepted-median → PriceCharting
guide (secondary evidence only) and is written only on explicit operator
approval. PriceCharting is always labeled a guide value, never a sold comp.

---

## Rate limiting

Every PriceCharting call from the edge function reserves a durable, global slot
via `reserve_api_request_slot` (≥1s apart across all isolates and retries). The
in-memory limiter in `src/lib/pricecharting` is retained as a secondary
within-isolate safeguard.

---

## Migrations (in order)
- `20260709000000_slab_admin.sql` — admin allowlist + `is_admin`
- `20260710000000_slab_inventory.sql` — tables + original RPCs + RLS
- `20260710000001_slab_images_storage.sql` — private bucket (MIME + 15 MB limits)
- `20260711000000_cert_normalization.sql` — normalized grader/cert + composite unique
- `20260712000000_slab_constraints.sql` — NOT NULL / CHECK / image-ext validation
- `20260713000000_api_rate_limits.sql` — durable PriceCharting reservation
- `20260714000000_slab_archive.sql` — archive / unarchive / hard delete
- `20260715000000_inventory_sequence.sql` — permanent, non-reused numbering
- `20260716000000_hard_delete_guard.sql` — `slab_settings` gate for hard delete

---

## Deployment status

Migrations and edge functions are authored and pass local typecheck/tests/build,
but have not been applied to a live project in this environment. Run the setup
steps above (and the integration tests in `src/test/integration/`) against a
dedicated GradedCardValue.com project to complete verification.
