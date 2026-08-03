# Phase B — eBay seller-operation boundary (backend)

Status: **scope + implementation spec** (code to follow on this branch).
Branch: `feat/ebay-seller-operation-boundaries` (base `main` @ 6d2faea).

## Key finding — the secure boundary already exists

The mature dispatcher `supabase/functions/_shared/ebay.ts` (`handleEbay(req, operation, deps)`)
already implements, for every existing seller op, exactly the properties Phase B requires:

- **admin-only**: `verifyAdmin` → `isCallerAdmin(req)` (JWT); non-admin/anon rejected.
- **server-side token**: `userAccessToken(admin, accountId)` decrypts the stored refresh
  token via service-role SECURITY DEFINER RPCs and refreshes it. The eBay access token is
  **never** returned to the caller and never accepted from the caller.
- **mutation kill-switches**: `mutationEnabled(Deno.env.get(FLAG))`, default OFF; read-only
  discovery is intentionally never gated.
- **observability**: `ebay_api_run_record` RPC per resource.
- **fail-closed**: `unavailable()` (409) / typed error replies; DI-testable.

Existing operations (all via `handleEbay`, thin `ebay-*/index.ts` shims):
`oauth_start, oauth_callback, account_sync, reference_search, list_item, revise_item,
end_item, order_sync, fulfillment, finances_sync, notification`.

**Therefore the bulk of Phase B is the FRONTEND rewire** (point the 5 seller-op modules at
these Edge Functions with the admin JWT, exactly like `fetchEbayConnectStatus`) — which
stacks on frontend PR #13 and is blocked until #13 merges.

## Genuinely-missing backend operations (this PR)

| op | eBay endpoint | inputs | output allowlist | migration? | mutation flag |
|----|---------------|--------|------------------|-----------|---------------|
| `inventory_read` | `GET /sell/inventory/v1/inventory_item?limit&offset` + `GET /sell/inventory/v1/offer?sku=` | `account_id`, `limit`, `offset` | sku, condition, title, qty, offer{offerId,status,price,marketplaceId,listingId} — **no** buyer PII, **no** token | no | none (read-only) |
| `listing_fees` | `POST /sell/inventory/v1/offer/get_listing_fees` | `account_id`, `offer_ids[]` | per-offer fee summaries (amount cents + currency + fee type) | no | none (read-only) |
| `disconnect` | — (local credential revoke) | `account_id` | `{status:"disconnected"}` only | **yes** — new `ebay_credential_delete(p_account_id)` service-role RPC | admin-only; optionally a new `EBAY_DISCONNECT_ENABLED` (default off) |

Notes:
- `inventory_read` / `listing_fees` need **no schema** — they reuse `userAccessToken` +
  `ebayFetch` + `reply`, mirroring the read-only `account_sync` handler (ebay.ts ~685).
- `disconnect` requires a forward migration adding a service-role `ebay_credential_delete`
  RPC (private schema). Validate disposable-PG → staging → advisors → **explicit prod
  approval** before any production apply. Deferred to a follow-up commit so the two
  read ops can land + deploy independently.

## Implementation steps (per op)

1. Add the op to the `Operation` union (ebay.ts ~24).
2. Add a handler branch in `handleEbay` (template: `account_sync`): parse `body`, resolve
   `userAccessToken`, `ebayFetch` the endpoint(s), map to the **allowlisted** shape, `reply`.
   Fail closed to `unavailable()` on token/credential failure.
3. Add a thin shim `supabase/functions/ebay-<op>/index.ts`:
   `Deno.serve((req) => handleEbay(req, "<op>"))`.
4. **Edge-coverage gate**: add each new function to the `deno check` list in
   `.github/workflows/ci.yml` and to `supabase/functions/CI-COVERAGE.md` (same gate PR #99
   satisfied), else the coverage meta-test fails.
5. Tests (`src/test/ebay/…`): admin-required (401/403), token-free output (secret-shape
   guard), allowlist-only, fail-closed on `loadAccessToken` failure, read ops never gated.

## Safety invariants (unchanged)

No access/refresh token, OAuth state, auth code, service-role key, or encrypted credential
in any response. Marketplace mutation flags stay **false**. No RuName change. Read ops are
not mutations. `disconnect` deletes only the local stored credential (live eBay listings are
unaffected) and never returns credential material.
