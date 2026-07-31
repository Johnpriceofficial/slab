# Administrator-authority unification plan (F5 + G4)

**Decision (owner):** **Option B** — `public.user_roles` is the single canonical
administrator authority. `auth.users.raw_app_meta_data.graded_card_value_admin` is
demoted to a **non-authoritative compatibility cache / UI hint**. `public.slab_admins`
is staged for deprecation. Redundant `app_role` values `admin` vs `administrator` are
normalized later.

**Constraint:** compatibility-preserving, measured migration. No legacy source is
dropped in the first migration. Nothing here has been applied to any environment.
Depends on the F4 migration-ledger reconciliation being done first.

---

## Deployed-schema inventory (authoritative, 2026-07-31)

Live `rcbwemkfcefarqnlgrmv`:

- **Only** `public.is_admin(uuid)` reads `raw_app_meta_data`. No other deployed
  function or trigger reads app_metadata.
- **44 RLS policies** call `is_admin()` (app-metadata-sourced today).
- **8 RLS policies** call `has_role()` (already `user_roles`-sourced).
- **No** deployed function reads `slab_admins`; **no** runtime `.ts` reads
  `slab_admins` or `has_role`.
- Every Edge Function checks admin via `isCallerAdmin()` → service-role
  `rpc('is_admin', {_user_id})` (`_shared/auth.ts`) — includes eBay
  (`ebay.ts`, `ebay-account-sync-v2.ts`), pricecharting-*, analyze-slab.
  **The audit's "eBay uses `has_role`" was imprecise — it uses `is_admin`.**
- Frontend `src/auth/AuthProvider.tsx` calls `rpc('is_admin', {_user_id: userId})`.

**Consequence:** because everything funnels through `is_admin()`, repointing that one
function at `user_roles` (plus a backfill) makes all **52** admin policies + every RPC
+ every Edge guard consistent from one source, with no other DB object touched.

Current admin membership: app_metadata = {owner `info@johnpricebookings.com`, test-admin};
`slab_admins` = {owner}; `user_roles('administrator')` = {test-admin}. This is exactly
the split — the owner passes the 44 `is_admin` policies but fails the 8 `has_role` ones.

---

## Migration 1 (this PR) — `20260910000000_admin_authority_unification.sql`

1. **Backfill** every current admin (app_metadata ∪ `slab_admins`) into
   `user_roles('administrator')` — idempotent. Result: `user_roles` administrators =
   {owner, test-admin}.
2. **Repoint `is_admin()`** to read `user_roles` only (signature/grants unchanged →
   all 52 policies + RPCs + Edge guards now user_roles-sourced; app_metadata unread).
3. **Add self-scoped helpers** `is_current_user_admin()` and
   `current_user_has_role(app_role)` (EXECUTE to `authenticated` only) so clients never
   pass an arbitrary `user_id`.

After this migration the owner and test-admin are both authoritative via `user_roles`,
and the eBay/`has_role` policies and the `is_admin` policies agree.

## Staged follow-up (later PRs — NOT in migration 1)

2. Migrate the **frontend** `AuthProvider` from `rpc('is_admin',{_user_id})` to
   `rpc('is_current_user_admin')` (slab-scribe-pro repo).
3. Migrate the **44 `is_admin` RLS policies** to `is_current_user_admin()` where they
   pass `auth.uid()` (mechanical), so the arbitrary-uid `is_admin(uuid)` is no longer
   needed by RLS.
4. **Then** revoke `EXECUTE` on `is_admin(uuid)` / `has_role(uuid,app_role)` from
   `authenticated` + `anon` (keep for `service_role`) — closes role enumeration (G4).
   *Cannot be done earlier:* RLS `is_admin(auth.uid())` needs the grant until step 3.
5. **`slab_admins` deprecation:** inventory every reader/writer (backend: none;
   frontend admin UI: TBD), migrate any admin-list writes to a scoped RPC (e.g.
   `grant_admin(user_id)` / `revoke_admin(user_id)`, `is_admin`-gated, writing
   `user_roles`), then revoke `authenticated` INSERT/UPDATE/DELETE on `slab_admins`,
   mark deprecated, and DROP only in a later migration once staging proves no caller.
6. **Enum normalization:** collapse `admin` → `administrator` (or vice-versa) after
   confirming no rows/policies use the losing value; drop the redundant label last.

## `slab_admins` DML end-state

No browser-level DML on administrator-authority tables. Path: identify writers →
route through scoped RPCs / trusted server ops → revoke `authenticated` DML on
`slab_admins` → deprecate → drop. PR #94 intentionally keeps the current RLS-gated DML
so the existing admin UI is not broken before that inventory is done.

## Staging verification matrix (owner runs; do NOT run against prod)

After applying migration 1 to an **isolated staging DB**:

| Actor | Expected |
|---|---|
| **owner** `info@…` | `is_admin(self)` = true; `is_current_user_admin()` = true; passes both an `is_admin` policy (e.g. read any `slabs`) and a `has_role` policy (e.g. an eBay table) |
| **administrator** (test) | same as owner (already in user_roles) |
| **customer** | `is_admin` = false; `is_current_user_admin()` = false; owner-scoped reads only; destructive/admin RPCs → 403 |
| **anonymous** | no access; self-scoped helpers not executable |
| **service-role** | `is_admin(any_uid)` still works (Edge `isCallerAdmin`) |

Also: `select count(*) from user_roles where role='administrator'` = number of real
admins (2 at authoring time); re-run the F6 grant audit unaffected.

## Owner decisions still required
- Confirm the two backfilled admins are the complete, correct admin set (no stray
  `slab_admins`/app_metadata entries that should NOT become admins).
- Confirm the frontend admin UI's `slab_admins` write path (for step 5 scoping).
- Choose the surviving enum label for normalization (`administrator` recommended —
  it is what `has_role` and the 8 policies already use).
