# Phase B — eBay seller-operation boundary (backend)

Status: **listing_fees + inventory_read + default-off disconnect implemented; disconnect migration awaiting staging/advisor review and explicit production approval**.
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
| `inventory_read` | `GET /sell/inventory/v1/inventory_item?limit&offset` + `GET /sell/inventory/v1/offer?sku=` | `account_id`, `limit`, `offset` | sku, condition, title, qty, offer{offerId,status,marketplaceId,format,price,listingId} — **no** buyer PII, **no** token | no | none (read-only) |
| `listing_fees` | `POST /sell/inventory/v1/offer/get_listing_fees` | `account_id`, `offer_ids[]` | per-offer fee summaries (amount cents + currency + fee type) | no | none (read-only) |
| `disconnect` | — (local credential revoke) | `account_id` | `{status:"disconnected"}` only | **yes** — `20260916000000_ebay_credential_delete.sql` adds service-role RPC | `EBAY_DISCONNECT_ENABLED` (default off) |

Notes:
- `inventory_read` / `listing_fees` need **no schema** — they reuse `userAccessToken` +
  `ebayFetch` + `reply`, mirroring the read-only `account_sync` handler.
- `disconnect` uses a dedicated, unit-tested admin-JWT Edge boundary. Its RPC deletes only
  `private.ebay_oauth_credentials`, marks the public account disconnected, and inserts a
  safe `ebay_api_runs` audit row in the same transaction. It never touches the legacy
  public OAuth tables or any eBay provider resource.
- The disconnect RPC migration must validate disposable-PG → staging → advisors →
  **explicit production approval** before any production apply. The Edge Function remains
  inert while `EBAY_DISCONNECT_ENABLED` is unset/false.

## Implementation steps (per op)

1. Add a strict request parser and response allowlist in a pure shared core.
2. Resolve every provider token or service-role database capability server-side; never
   accept or return token material.
3. Add a thin `supabase/functions/ebay-<op>/index.ts` shim/boundary.
4. **Edge-coverage gate**: add each new function/core to the `deno check` list in
   `.github/workflows/ci.yml` and to `supabase/functions/CI-COVERAGE.md`.
5. Tests (`src/test/ebay/…`): admin-required (401/403), token-free output, allowlist-only,
   fail-closed dependency errors, default-off destructive operations, and disposable
   database verification for every new SECURITY DEFINER RPC.

## Safety invariants (unchanged)

No access/refresh token, OAuth state, auth code, service-role key, or encrypted credential
in any response. Marketplace mutation flags stay **false**. `EBAY_DISCONNECT_ENABLED`
stays **false** outside an explicitly approved test window. No RuName change. Read ops are
not mutations. `disconnect` deletes only the local canonical stored credential (live eBay
listings are unaffected) and never returns credential material.
