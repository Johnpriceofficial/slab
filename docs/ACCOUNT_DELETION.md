# Customer Account Deletion — Design & Retained-Data Policy

Implemented by migration `20260906000000_account_deletion.sql`
(`public.purge_customer_account_data`).

## Why a supported workflow is required

36 columns reference `auth.users(id)`. **14 use `ON DELETE RESTRICT`**, so a
raw `DELETE FROM auth.users` fails for any account that ever owned a slab or
scanned a card. The remaining FKs are `ON DELETE CASCADE` (4) or `SET NULL`
(18) and need no action.

### RESTRICT foreign keys (the blocking set)

Slab graph (rooted at `slabs.owner_id`), all in
`20260803000000_customer_slab_ownership.sql`:
`slabs.owner_id`, `slab_images.owner_id`, `image_derivatives.owner_id`,
`slab_comps.owner_id`, `ai_analysis_runs.owner_id`, `ai_field_evidence.owner_id`,
`valuation_snapshots.owner_id`, `slab_product_links.owner_id`,
`slab_product_candidates.owner_id`, `slab_pricecharting_events.owner_id`,
`sold_comps.owner_id`.

Raw-scanner graph (`20260801000000_live_card_scanner.sql`):
`card_scans.created_by`, `cards.created_by`, `card_scan_reviews.created_by`.

### CASCADE / SET NULL (handled automatically by Phase 2)

`customer_profiles.id`, `api_user_daily_usage.user_id`, `slab_admins.user_id`,
`private.ebay_oauth_states.requested_by` cascade. `audit_log.actor_user_id` /
`audit_log.owner_id`, `slabs.visual_confirmation_by`, `card_scan_reviews.resolved_by`
and ~14 other actor/creator columns null out.

## Chosen strategy: transactional purge, then Auth deletion

**Phase 1 — `public.purge_customer_account_data(p_user_id uuid default null)`**
(`SECURITY DEFINER`, fixed `search_path`, one transaction ⇒ atomic):

1. **Authorization (fail-closed):** `auth.uid()` must be present; a customer may
   purge only their own account (`p_user_id` null or equal to `auth.uid()`); an
   administrator (`is_admin`) may target any account, and the override is
   flagged in the audit record. No JWT identity ⇒ `42501`. Deliberately **not**
   gated on `slab_settings.allow_hard_delete` — that break-glass flag guards the
   admin *bulk* purge UI; a user erasing their own account, or an audited admin
   action, is a distinct authorized capability.
2. **Slab graph:** writes immutable `slab_deletion_tombstones`, an `audit_log`
   `hard_delete` row per slab, and queues every `slab-images` object
   (front/back + `slab_images` + `image_derivatives` + orphan objects under
   `slabs/<inventory_number>/`); deletes the SET-NULL-on-slab rows
   (`ebay_order_line_items`, `marketplace_events`, `sold_comps`) explicitly;
   deletes the owner's `slabs`, cascading the 8 slab-child tables. This mirrors
   the proven `purge_slabs` logic, scoped by `owner_id`.
3. **Raw-scanner graph:** queues each `card-scans` object
   (`<uid>/<scan>.jpg`); deletes `cards` (their `source_scan_id` RESTRICTs the
   scan) then `card_scans` (cascading `card_scan_reviews`).
4. **Final record:** one `account_data_purged` audit row with only the target
   uuid, the admin-override flag and counts — no email or other PII.
5. Returns a JSON summary (`slabs_deleted`, `card_scans_deleted`,
   `storage_paths_queued`).

**Phase 2 — service-role Auth deletion** (`auth.admin.deleteUser(target)`),
performed by the caller after Phase 1. With every RESTRICT dependency cleared it
now succeeds, and the CASCADE FKs remove `customer_profiles`,
`api_user_daily_usage`, `slab_admins` and the ebay oauth state. A Postgres RPC
cannot itself remove a GoTrue-managed `auth.users` row, so this stays with the
service-role caller (a self-service edge function or an admin tool — not in this
PR's scope, and not deployed here).

## Atomicity, storage, and consistency

- Phase 1 is a single PL/pgSQL transaction: any failure rolls the entire purge
  back, so no partial/inconsistent deletion is possible.
- Object bytes are removed asynchronously — there is no server-side worker.
  Every path is durably enqueued in `private.slab_storage_cleanup_queue` with
  its `bucket_id` (`slab-images` and `card-scans`); the existing admin cleanup
  consumer (`src/lib/slabs/inventory-maintenance.ts`) drains it idempotently.
- A concurrent admin `purge_slabs` and an account purge serialize on the shared
  advisory lock `918273646`, so storage-queue writes never race.

## Retained-data policy

`audit_log` and `slab_deletion_tombstones` are **append-only** and deliberately
survive account deletion (compliance / anti-abuse evidence). Their `auth.users`
references are `SET NULL` (audit) or plain uuid with no FK (tombstones), so once
Phase 2 removes the Auth user **no retained row identifies the customer by a
live user id**, and no retained row stores their email or other PII. The
tombstone keeps slab-identity fields (grader, grade, cert number, inventory
code) for dispute/fraud evidence — never customer contact data. If a data-
retention law or policy later requires stricter erasure of the pseudonymous
uuid, that is a follow-up; this design keeps the minimum evidence, de-identified.

## Authorization matrix

| Caller | Target | Result |
|---|---|---|
| anonymous | any | `42501` (no `auth.uid()`) |
| customer | self (`null`/own id) | purge succeeds |
| customer | another user | `42501` NOT_AUTHORIZED |
| administrator | any user | purge succeeds, `admin_override=true` audited |

## Tests

`src/test/integration/account-deletion.integration.test.ts` (env-gated, live):
direct Auth deletion of a slab-owner fails safely (RESTRICT); the supported
workflow purges slab + card-scan data and the Auth user then deletes cleanly
(cascading the profile); cross-user purge is refused; admin override succeeds
and is audited; anonymous is refused; an empty account purges idempotently.
