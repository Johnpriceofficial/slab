# Edge Function CI coverage

Every production Edge Function under `supabase/functions/` is either **static-checked in CI**
(`deno check --no-config --node-modules-dir=manual --no-remote`) or listed here as a
**justified exclusion**. This file is the source of truth the CI `Deno-check edge functions`
step is kept in sync with.

## Deno-checked in CI

- `analyze-slab`
- `market-intelligence`
- `marketplace-scheduler`
- `pricecharting-marketplace`
- `pricecharting-search`
- `pricecharting-sync`

## Generated bundles (freshness-gated in CI)

The `_shared/*-bundle.js` files are generated from `src/` by the `scripts/build-*-edge-bundle.mjs`
builders and are **not** hand-edited. CI rebuilds all four and fails if the committed output is
stale:

- `_shared/pricecharting-bundle.js` ← `build-pricecharting-edge-bundle.mjs`
- `_shared/pricecharting-marketplace-bundle.js` ← `build-pricecharting-marketplace-edge-bundle.mjs`
- `_shared/analyze-slab-bundle.js` ← `build-analyze-slab-edge-bundle.mjs`
- `_shared/market-intelligence-bundle.js` ← `build-market-intelligence-edge-bundle.mjs`

## Excluded from `deno check` (justified)

These functions are **not** yet deno-checked because they fail under the strict CI flags
(`--no-config`, which uses the default TypeScript lib rather than a Deno-aware config) for
reasons **unrelated to their runtime behavior**:

| Function | Reason |
| --- | --- |
| `ebay-account-sync`, `ebay-end-item`, `ebay-finances-sync`, `ebay-fulfillment`, `ebay-list-item`, `ebay-notification-handler`, `ebay-oauth-callback`, `ebay-oauth-start`, `ebay-order-sync`, `ebay-reference-search`, `ebay-revise-item` | All dispatch to `_shared/ebay.ts`, which trips two pre-existing type errors under `--no-config`: `crypto.subtle.importKey("raw", Uint8Array, …)` (WebCrypto `BufferSource`/`SharedArrayBuffer` lib mismatch) and `admin.schema("private")` (supabase-js client overload). Both need a Deno-aware `deno.json` lib config to resolve. |
| `scan-card` | Same WebCrypto `Uint8Array`/`Buffer` lib mismatch under `--no-config`. |

These are latent (the functions were never in CI's deno-check before) and fixing them —
introducing a Deno config or adjusting the WebCrypto/`schema` typings across the eBay surface —
is deliberately **out of scope** for the market-intelligence hardening PR, which must not alter
unrelated function behavior. Tracked as follow-up: add a `deno.json` for the functions workspace
so the full surface can be checked, then move every row above into the checked list.
