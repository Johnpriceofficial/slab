# PriceCharting Integration — Verification Report

_Generated after implementation. All figures reflect the committed code and a
passing test run (`bun run test -- src/test/pricecharting`)._

## Test results

```
Test Files  6 passed (6)
     Tests  80 passed (80)
```

Type check: `bunx tsc --noEmit -p tsconfig.app.json` — no errors in
`src/lib/pricecharting`.

| Test file | Tests | Focus |
|---|---|---|
| `money.test.ts` | 11 | penny↔dollar, null vs 0, float-trap avoidance, rounding |
| `client.test.ts` | 16 | id/UPC/search, not-found, auth, retry/backoff, malformed JSON, rate limit, cache, dedupe, missing token |
| `matching.test.ts` | 6 | strong match, ambiguity, conflict rejection, unresolved, explicit id |
| `valuation.test.ts` | 15 | ungraded, general Grade 9, PSA/BGS/CGC/SGC 10, unsupported grade, quantity, video-game conditions, comic grades, coin (no mapping), all-conditions |
| `marketplace.test.ts` | 19 | list/sold/details, confirmation gates, SKU/description/condition validation, duplicate SKU, refund double-confirm, already-refunded, PII masking |
| `inventory.test.ts` | 13 | cost basis, recovery, zero-basis null %, partial sold, realized/unrealized/projected, unknown value |

## Endpoints implemented

| Endpoint | Function(s) | Method |
|---|---|---|
| `/api/product` | `getProductById`, `getProductByUPC` | GET |
| `/api/products` | `searchProducts` | GET |
| `/api/offers` | `listMarketplaceOffers`, `listSoldMarketplaceOffers` | GET |
| `/api/offer-details` | `getOfferDetails` | GET |
| `/api/offer-publish` | `publishOffer`, `editOffer` | POST |
| `/api/offer-feedback` | `leaveOfferFeedback` | POST |
| `/api/offer-ship` | `markOfferShipped` | POST |
| `/api/offer-end` | `endOffer` | POST |
| `/api/offer-refund` | `refundOffer` | POST |
| CSV bucket | reserved in rate limiter (`config.ts` `csv`), no downloader shipped | — |

## Required core functions (35/35 implemented)

1–3 `searchProducts`, `getProductById`, `getProductByUPC` → `api.ts`
4 `findBestProductMatch` → `matching.ts`
5–10 `getProductValuation`, `getCardValuation`, `getVideoGameValuation`,
`getComicValuation`, `getCoinValuation`, `getValuesForAllConditions` →
`valuation.ts`
11 `getValueForRequestedGrade` → `grade-mapping.ts`
12–13 `convertPenniesToDollars`, `convertDollarsToPennies` → `money.ts`
14–22 `listMarketplaceOffers`, `listSoldMarketplaceOffers`, `getOfferDetails`,
`publishOffer`, `editOffer`, `markOfferShipped`, `leaveOfferFeedback`,
`endOffer`, `refundOffer` → `marketplace.ts`
23–30 `calculateInventoryValue`, `calculateCollectionValue`,
`calculateCostBasis`, `calculateRecoveredAmount`, `calculateUnrecoveredCost`,
`calculateProfitLoss`, `calculateRecoveryPercentage`, `calculateProjectedProfit`
→ `inventory.ts`
31 `validateAPIResponse` → `client.ts`
32 `sanitizeSensitiveData` → `logger.ts`
33 `applyRateLimit` → `client.ts` (delegates to `rate-limiter.ts`)
34 `retrySafeRequest` → `client.ts`
35 `createAuditLog` → `audit.ts`

## Requires a paid PriceCharting subscription

Everything that performs a live API call: all product lookups/searches, all
valuations (which fetch product data), and every marketplace operation. Missing
or invalid token → `AUTHENTICATION_ERROR` / `SUBSCRIPTION_REQUIRED`. All 80
tests run fully mocked and need **no** subscription.

## Features that cannot provide historical sold data

- `getProductValuation` and every category valuation return **current market
  estimates only**. `is_historical_sale: false`, `is_ebay_last_sold: false`, and
  a warning are always attached.
- `listSoldMarketplaceOffers` returns only sold **PriceCharting Marketplace**
  offers visible to the account — **not** all eBay sold transactions.
- No endpoint returns "last sold" / "latest sale" / eBay last-sold prices. For a
  true eBay-sold value, plug a separate verified eBay data source into the
  caller; this library will not mislabel a current value as a sale.

## Outputs that are PriceCharting current values

Every `ValuationResult.valuation.*` figure and every entry in
`available_values` is a current market value, labeled via `source_type:
"current_market_value"`.

## Actions requiring explicit confirmation

| Action | Confirmation |
|---|---|
| `publishOffer`, `editOffer` | `confirm: true` |
| `markOfferShipped` | `confirm` arg `true` |
| `endOffer` | `{ confirm: true }` |
| `refundOffer` | `{ confirm_refund: true }` — dedicated second confirmation; **never automatic** |

`leaveOfferFeedback` requires a valid rating (−2…2) but is non-destructive.

## Assumptions & limitations

1. **`/api/products` returns price fields.** When a search result already
   contains price fields, `findBestProductMatch` values it directly (one call).
   If your PriceCharting plan returns price-less search rows, call
   `getProductById(match.pricecharting_id)` before reading prices. (The code
   tolerates both; the shipped path uses whatever prices the payload includes.)
2. **Coin grade mapping.** PriceCharting publishes no documented coin
   grade→field mapping, so coin grade requests return `null` (with a warning)
   and expose raw fields under generic labels — never card/comic/game mappings.
3. **Card field semantics** follow the provided spec
   (`cib`=Grade 7/7.5, `new`=8/8.5, `graded`=general 9, `box-only`=9.5,
   `manual-only`=PSA 10, `bgs-10`=BGS 10, `condition-17`=CGC 10,
   `condition-18`=SGC 10). If PriceCharting changes these, update
   `grade-mapping.ts` only.
4. **SKU uniqueness** is a best-effort check against `available` + `collection`
   offers; a transient offers outage does not block a legitimate publish (it is
   logged, not fatal). A hard conflict is fatal (`VALIDATION_ERROR`).
5. **Write transport.** POST endpoints send parameters as query string (matching
   PriceCharting's documented style) with an optional `Idempotency-Key` header.
6. **CSV downloader** is intentionally not shipped (no requirement to consume the
   daily CSV); its 10-minute rate bucket is reserved so a future downloader
   cannot breach the limit.
7. **Recovered amount** includes `sale_price + shipping_premium` as proceeds;
   pass only genuinely-sold offers. Realized P/L uses each sold offer's own cost
   basis when present.

No further assumptions remain; nothing is left unfinished or stubbed.
