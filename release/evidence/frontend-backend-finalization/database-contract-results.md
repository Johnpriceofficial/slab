# Database contract results (disposable execution)

Executed against the disposable clean-installed canonical schema (Test A). No
production or customer data was used. Scripts: `scripts/verify/contract-tests.sql`.

## Administrator authority — PASS

Canonical/deployed model: `is_admin(uuid)` (SECURITY DEFINER, `search_path`
pinned) reads `auth.users.raw_app_meta_data->>'graded_card_value_admin'`.

- administrator (app_metadata flag) → **allowed**
- normal authenticated customer → **denied**
- unknown/absent user id → **denied** (no automatic promotion)
- unauthenticated (`auth.uid()` null) → **denied**
- fail-closed default `false`

**Split-authority note:** production also has `has_role`/`app_role`/`user_roles`
which the canonical chain does not create. App metadata is authoritative in the
*deployed* model; the approved single-source model (`user_roles`) is draft PR #95,
unmerged. This is reported, not resolved here.

## Account deletion — PASS

`purge_customer_account_data(uuid)` (SECURITY DEFINER, `search_path = public,
private, storage, auth`):

- unauthenticated caller → **refused** (`AUTH_REQUIRED`)
- authorized self-purge → completes **FK-safe** (the 14 `ON DELETE RESTRICT`
  FKs to `auth.users` are the reason the function exists)
- target app-data cleaned; **unrelated user + slab untouched**
- storage cleanup **enqueued** to `private.slab_storage_cleanup_queue` (auditable;
  no synchronous byte deletion — a consumer drains the queue)
- the function does **not** delete `auth.users`; the auth identity is removed in a
  **separate step after** application cleanup succeeds

**Missing-in-prod note:** `purge_customer_account_data` is **absent in production**
(see reconciliation). Verified only on the disposable clean schema.

## Grading quota / catalog visibility / shared rate limiting — PASS (in the frontend repo, not the slab backend)

These objects (`consume_grading_advice_quota`, grading catalog + RLS,
`try_rate_limit_consume`) are **`slab-scribe-pro` backend-patches**, not part of
the `slab` backend, and are **not present in production**. They were executed and
passed against a disposable Postgres in the prior PR #8 review session:

- **grading quota** — definer write; idempotent retry consumes once; limit
  boundary denies; per-user advisory lock (no over-allowance); direct authenticated
  UPDATE denied; cross-user isolated.
- **catalog visibility** — only active/published rows readable; draft/inactive/
  retired/unpublished hidden; child visibility inherits published parent;
  authenticated writes denied; service-role maintenance possible.
- **shared rate limiting** — `pg_advisory_xact_lock` check-and-insert; two
  contenders for the last slot yield exactly one winner; count never exceeds max;
  malformed params rejected; fail-closed on RPC error; service-role-only.

These belong to the frontend repo's backend-patches and would be applied to the
Supabase backend only via the same owner-gated, staging-first ledger process.
