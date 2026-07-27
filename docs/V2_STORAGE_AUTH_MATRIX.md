# V2 Storage & Auth Matrix

> Generated from commit `ba3953fdb68c31435c7dac732f67d8d53aa2adcb` on 2026-07-27.
> **Documentation of existing behavior** — this file describes what the V1 system does today
> (live production project `rcbwemkfcefarqnlgrmv` + this repo). It prescribes nothing.

Live facts below were read directly from production (`storage.buckets`, `pg_policies`,
`pg_get_functiondef`) and cross-checked against `supabase/migrations/` and `src/`.

---

## 1. Buckets (live-verified)

| Bucket | public | file_size_limit | allowed_mime_types |
|---|---|---|---|
| `slab-images` | `false` | 15,728,640 (15 MB) | `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif` |
| `card-scans` | `false` | 10,485,760 (10 MB) | `image/jpeg` |

Both buckets are **private**: no public object URLs; every read goes through a signed URL
(or through an edge function running as `service_role`). Bucket-level
`allowed_mime_types` / `file_size_limit` are enforced by Supabase Storage itself for
**every** uploader — including admins — proven by the integration test
`src/test/integration/slabvault.integration.test.ts:251`
("enforces storage MIME + size limits on the private bucket": a `image/gif` upload and a
16 MB upload are both rejected for an admin client).

Defined in `supabase/migrations/20260710000001_slab_images_storage.sql` (slab-images) and
`20260801000000_live_card_scanner.sql` (card-scans).

## 2. Storage policy matrix (live-verified: exactly 6 policies on `storage.objects`)

| Policy | cmd | roles | Rule (qual / with_check) |
|---|---|---|---|
| `slab-images owner read` | SELECT | `authenticated` | `bucket_id='slab-images' AND (is_admin(auth.uid()) OR slab_object_owner(name)=auth.uid())` |
| `slab-images owner insert` | INSERT | `authenticated` | same expression (as `with_check`) |
| `slab-images owner update` | UPDATE | `authenticated` | same expression (as `qual`) |
| `slab-images owner delete` | DELETE | `authenticated` | same expression (as `qual`) |
| `card-scans owner read` | SELECT | `authenticated` | `bucket_id='card-scans' AND (storage.foldername(name))[1] = auth.uid()::text` |
| `card-scans owner insert` | INSERT | `authenticated` | same expression (as `with_check`) |

Role/verb matrix that falls out of this:

| Bucket | anon | authenticated (owner) | authenticated (admin) | service_role |
|---|---|---|---|---|
| `slab-images` | nothing | SELECT / INSERT / UPDATE / DELETE on objects whose `slabs/<n>/…` prefix resolves to a slab they own | SELECT / INSERT / UPDATE / DELETE on **all** slab-images objects | everything (RLS bypass) |
| `card-scans` | nothing | SELECT / INSERT only, and only under their own `<uid>/…` folder — **no client UPDATE or DELETE exists for anyone** | same as any customer (admin gets **no** extra card-scans access from these policies) | everything (RLS bypass) |

Ownership helpers (live definitions):

- `public.is_admin(_user_id uuid)` — `SECURITY DEFINER`; returns true iff
  `auth.users.raw_app_meta_data->>'graded_card_value_admin'` is `true` for that user.
  (Originally an allowlist table `public.slab_admins` — `20260709000000_slab_admin.sql`;
  redefined onto immutable `app_metadata` in `20260729000000_evidence_and_integrations.sql`.
  The `slab_admins` table still exists in production but is no longer what `is_admin` reads.)
- `public.slab_object_owner(p_name text)` — `SECURITY DEFINER`; parses the object path:
  if segment 1 is `slabs` it looks up `public.slabs.owner_id` by
  `inventory_number = segment 2`. So slab-image object access is derived from **row
  ownership of the slab**, not from the storage `owner` column. Introduced in
  `20260803000000_customer_slab_ownership.sql` (kept keyed on the permanent inventory
  number by `20260804000000_permanent_inventory_ids.sql`).

## 3. Path conventions (exact rules)

### `slab-images`

Paths are **server-assigned** by the `create_slab` RPC
(`20260803000000_customer_slab_ownership.sql`), never invented by the client:

- Normalized front (always): `slabs/<inventory_number>/front.<ext>`
- Normalized back (optional): `slabs/<inventory_number>/back.<ext>`
- `<ext>` is validated by `public.valid_image_ext` (jpg/jpeg/png/webp/heic/heif family);
  `<inventory_number>` comes from `public.slab_inventory_seq`.
- Byte-for-byte camera originals, only when browser normalization changed the bytes
  (notably HEIC→JPEG): `slabs/<inventory_number>/original/<front|back>.<original_ext>`
  — built client-side at `src/lib/slabs/save-slab.ts:254`.
- There is **no** `derivatives/` storage folder: the `image_derivatives` table row for the
  normalized decode points its `storage_path` at the main `slabs/<n>/<role>.<ext>` object
  (`registerImageEvidence`, `src/lib/slabs/data.ts:96-124`). The AI "analysis variants"
  (`src/lib/slabs/image-derivatives.ts`) are in-memory only and are sent base64 to the
  `analyze-slab` function — never stored.
- `test/<stamp>/…` appears only in integration tests.

`slab_object_owner()` only understands the `slabs/<inventory_number>/…` shape; any other
prefix resolves to NULL owner and is therefore admin-or-nothing.

### `card-scans`

Client-built, owner-rooted (`src/lib/cards/stage-raw.ts:53-55`):

- Front: `<auth.uid()>/<uuid>.jpg`
- Back (optional): `<auth.uid()>/<uuid>-back.jpg`

The INSERT policy requires folder segment 1 to equal `auth.uid()`, and `stage_raw_card`
(`20260806000000_front_back_intake.sql`) re-checks the same rule on both paths inside the
RPC (defense in depth) before creating `card_scans` + `cards` rows. The `scan-card` edge
function writes scans server-side as `service_role` (bypasses RLS).

## 4. Upload behavior (V1 frontend)

- **Direct client uploads with the user's JWT** — plain
  `supabase.storage.from(bucket).upload(path, blob, { upsert: false, contentType })`.
  No signed-upload-URL flow exists anywhere in `src/`.
  - Slabs: `uploadImage` in `src/lib/slabs/data.ts:89-94` (contentType = blob type, falls
    back to `image/jpeg`).
  - Raw cards: `src/lib/cards/stage-raw.ts:57-62` (always `image/jpeg`).
- **Ordering (slab intake, `src/lib/slabs/save-slab.ts`)**: 1) `create_slab` RPC assigns
  the inventory number and returns the storage paths; 2) client uploads front (and back)
  to those returned paths; 3) originals preserved under `original/` when needed and
  evidence registered (`slab_images` / `image_derivatives` upserts); 4) failures run
  compensating cleanup (`remove` + `slabs` row delete) with explicit orphan warnings.
- **Content-type / size enforcement is DB/storage-side**: the bucket's
  `allowed_mime_types` and `file_size_limit` reject bad uploads regardless of role
  (test at `src/test/integration/slabvault.integration.test.ts:251`). Client-side
  `normalizeImageExt` validation in `save-slab.ts` is UX-only. On the raw-card side,
  `card_scans` additionally constrains `mime_type = 'image/jpeg'` and
  `byte_size <= 10485760` at the table level (`20260801000000_live_card_scanner.sql`).
- `upsert: false` everywhere — the client never overwrites an existing object; UPDATE
  policy on slab-images exists but no frontend code path uses it.

## 5. Retrieval (signed URLs)

- Private buckets mean **every** browser image render uses
  `createSignedUrl(path, expiresSeconds)`:
  - `signedImageUrl(path, expiresSeconds = 3600)` — `src/lib/slabs/data.ts:369`
  - `signedImageState(path, expiresSeconds = 3600)` — `src/lib/slabs/data.ts:382`
    (returns typed `no_path | ready | signing_error` so the UI can distinguish "no image"
    from "signing failed"). Used by `src/pages/slabs/SlabDetail.tsx:66-67`.
  - **TTL used in practice: 3600 s (1 h)** — no caller overrides the default.
- Raw-card images/thumbnails are returned by the `scan-card` edge function
  (`thumbnail_url` / `image_url` on its responses) — signing happens server-side.
- CSP (`vercel.json`) allows `img-src 'self' data: blob: https:`, so signed
  `*.supabase.co` URLs render; `connect-src` is pinned to
  `https://rcbwemkfcefarqnlgrmv.supabase.co` (+ wss + hCaptcha).

## 6. Auth flows

- **Provider**: Supabase email/password only. All flows go through
  `src/auth/AuthProvider.tsx`, which exposes a status machine:
  `loading | signed_out | unverified | customer | admin`.
- **hCaptcha**: `src/components/auth/useHCaptcha.ts` enables captcha when
  `VITE_HCAPTCHA_SITE_KEY` is set; `HCaptchaWidget` renders it on **Login, Signup and
  ForgotPassword** (`src/pages/*.tsx`); the token is passed as `captchaToken` to
  `signInWithPassword` / `signUp` / `resetPasswordForEmail`. `vercel.json` CSP allowlists
  `js.hcaptcha.com` / `*.hcaptcha.com` for script/style/frame/connect.
- **Signup / verification**: `signUp` with `emailRedirectTo = <origin>/login?confirmed=1`;
  a session whose `email_confirmed_at` is null resolves to status `unverified`
  (blocked from the app shell). Signup page enforces a 10+ char password client-side.
- **Password reset**: ForgotPassword → `resetPasswordForEmail(email, { redirectTo:
  <origin>/reset-password })`; ResetPassword page (recovery session) calls
  `updateUser({ password })`. No captcha on the reset-password (already-authenticated)
  step.
- **Admin model**: after each sign-in/refresh the provider probes
  `rpc("is_admin", { _user_id })` (`AuthProvider.tsx:36`). Live `is_admin` reads
  `app_metadata.graded_card_value_admin` (immutable to the user; set server-side only).
  Admins bypass owner scoping in RLS and RPCs; staff accounts are provisioned outside the
  customer flow.
- **Customer profiles**: `public.customer_profiles` (`20260802000000_public_customer_accounts.sql`)
  — `plan` (free/paid/staff), `account_status` (active/suspended/closed),
  `daily_scan_limit` (default 5; staff backfilled at 300). Created automatically by the
  `create_customer_profile_after_signup` trigger (AFTER INSERT ON `auth.users`,
  SECURITY DEFINER, service_role-only execute). RLS: owner may SELECT own row only; all
  writes are service_role.
- **Suspension mechanism**: there is no auth-level ban — enforcement is per-operation:
  - `create_slab` (`20260803…sql:393-401`): unless `is_admin`, it selects
    `customer_profiles.account_status` and raises `NOT_AUTHORIZED` (42501) when the
    status `is distinct from 'active'`.
  - `stage_raw_card` (`20260806…sql:59-64`): identical gate.
  - `consume_user_daily_quota` (`20260802…sql`): only finds a limit row
    `where account_status = 'active'`, so scans silently hit "quota denied" for
    suspended/closed accounts.
  - Existing owner-scoped reads (slabs, storage) are **not** revoked by suspension.

## 7. Per-frontend-operation matrix (storage-touching operations)

| Operation (frontend) | Bucket | Path rule | Who | Mechanism | Notes |
|---|---|---|---|---|---|
| Slab intake: upload normalized front/back | `slab-images` | `slabs/<n>/front.<ext>`, `slabs/<n>/back.<ext>` (paths returned by `create_slab`) | owner or admin | direct `upload`, `upsert:false` | `src/lib/slabs/data.ts:89`; MIME/size enforced by bucket config |
| Slab intake: preserve camera original | `slab-images` | `slabs/<n>/original/<role>.<orig_ext>` | owner or admin | direct `upload` | only when normalization changed bytes (HEIC); `save-slab.ts:254` |
| Slab intake: compensating cleanup | `slab-images` | the paths just uploaded | owner or admin | `remove` | `save-slab.ts` failure paths via `deleteImages` |
| View slab images | `slab-images` | `front_image_path` / `back_image_path` from the slab row | owner or admin | `createSignedUrl`, **TTL 3600 s** | `signedImageUrl` / `signedImageState` |
| Hard-delete slab images | `slab-images` | paths returned by `hard_delete_slab` RPC | admin (RPC-gated + `slab_settings.allow_hard_delete`) | `remove` | `data.ts:351-367` |
| Purge / retry queued cleanup | `slab-images` | paths from `purge_slabs` / `list_pending_slab_storage_cleanup` RPCs | admin | `remove` in 1000-path batches, then ack RPC | `src/lib/slabs/inventory-maintenance.ts` |
| Raw-card stage: upload capture | `card-scans` | `<uid>/<uuid>.jpg`, `<uid>/<uuid>-back.jpg` | owner (folder must equal `auth.uid()`) | direct `upload`, `upsert:false`, `image/jpeg` | `stage-raw.ts:57-62`; then `stage_raw_card` RPC |
| Raw-card image display | `card-scans` | server-chosen | any signed-in customer (own rows) | edge function returns signed `thumbnail_url`/`image_url` | `scan-card` function signs as service_role |

No frontend code performs a storage UPDATE (move/copy/overwrite) in either bucket, and no
client path can delete from `card-scans` (no DELETE policy exists there).
