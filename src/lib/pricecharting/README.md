# PriceCharting Integration

Production-ready, framework-agnostic TypeScript client for the
[PriceCharting](https://www.pricecharting.com) API. Handles collectibles
valuation (cards, sports cards, video games, comics, coins, Funko Pops, LEGO,
and more), marketplace offers, inventory/cost-recovery accounting, and all the
safety rails PriceCharting's limits and money semantics require.

> **Accuracy over speed.** The library never guesses a product, grade, variant,
> or value. A value is only assigned when a confident product match is made.

---

## Architecture

Single-responsibility modules, all dependency-injected (fetch, clock, token,
logger, audit sink) so behavior is deterministic and fully testable.

```
src/lib/pricecharting/
├── index.ts          Public barrel (import from here)
├── service.ts        createPriceChartingService() — recommended facade
├── config.ts         Base URL, rate limits, retry policy, endpoint paths, token env
├── clock.ts          Injectable Clock (systemClock / FakeClock)
├── money.ts          Integer-penny currency (no floating-point money math)
├── errors.ts         PriceChartingError + normalized error codes
├── logger.ts         Structured logging + sanitizeSensitiveData (PII/token masking)
├── audit.ts          createAuditLog — audit trail for writes/financial actions
├── rate-limiter.ts   Centralized per-bucket limiter (1/s, 10-min CSV, 5-min offers)
├── cache.ts          TTL cache + in-flight duplicate-request suppression
├── client.ts         PriceChartingClient — applyRateLimit, retrySafeRequest, validateAPIResponse
├── product.ts        Raw → normalized Product mapping
├── api.ts            searchProducts, getProductById, getProductByUPC
├── grade-mapping.ts  CATEGORY-SPECIFIC price-field interpretation, getValueForRequestedGrade
├── matching.ts       findBestProductMatch — normalize → search → score → confidence gate
├── valuation.ts      getProductValuation + per-category valuation
├── marketplace.ts    Offers: list/details/publish/edit/ship/feedback/end/refund
└── inventory.ts      Cost basis, recovery, realized/unrealized/projected P&L
```

**Request flow (every call):** `applyRateLimit` (bucketed queue) →
`retrySafeRequest` (exponential backoff + full jitter, transient-only) →
`validateAPIResponse` (normalized errors) → typed model. GET reads are cached
and de-duplicated; writes are never cached and accept an idempotency key.

---

## Setup

1. **Subscription & token.** A **paid PriceCharting API subscription** is
   required. Set the token as a *server-side* environment variable — never with
   a `VITE_` prefix (that would ship it to the browser):

   ```bash
   export PRICECHARTING_API_TOKEN="your-subscription-token"
   ```

   See `.env.template`. The token is read at call time via
   `process.env.PRICECHARTING_API_TOKEN` and is **never** logged, returned, or
   stored in clear text.

2. **Runtime.** Needs a `fetch` implementation (Node 18+, Bun, Deno, or edge
   runtimes provide one globally). This module is server-side; do not import it
   into client bundles.

## Run

```bash
bun run test -- src/test/pricecharting     # unit + mocked integration tests
bunx tsc --noEmit -p tsconfig.app.json     # type check
```

All network is mocked in tests — **no live subscription is needed to run them.**

---

## Usage

```ts
import { createPriceChartingService } from "@/lib/pricecharting";

const pc = createPriceChartingService(); // reads PRICECHARTING_API_TOKEN

// Graded card — value only assigned at high confidence
const card = await pc.getCardValuation({
  category: "trading_card",
  card_name: "Charizard",
  card_number: "4",
  set: "Base Set",
  year: 1999,
  variant: "Holo",
  grading_company: "PSA",
  grade: 9,
});
// -> ValuationResult (field_used: "graded-price", company_specific: false,
//    warning: "general Grade 9, not company-specific")
//    OR an ErrorResult { error_code: "AMBIGUOUS_PRODUCT", details.candidates }

// Video game
const game = await pc.getVideoGameValuation({
  category: "video_game", title: "EarthBound", console: "Super Nintendo", condition: "cib",
});

// Marketplace — writes require explicit confirmation
await pc.publishOffer({ product: "6910", price_max_dollars: 250, confirm: true });
await pc.markOfferShipped("offer-123", "1Z999...", /* confirm */ true);

// Refunds need a SECOND, dedicated confirmation and are never automatic
await pc.refundOffer("offer-123", { confirm_refund: true });

// Inventory / recovery accounting (pure, integer-penny math)
const report = pc.buildInventoryReport(items, soldOffers);
```

For advanced use, every function is also exported standalone and accepts a
`PriceChartingClient` as its first argument (see `index.ts`).

---

## Key guarantees

- **Money:** all internal arithmetic is on integer pennies; dollars are produced
  only at the display boundary. `null` is never coerced to `0`.
- **Grades:** category-specific field mapping. General Grade 9 (`graded-price`)
  is never described as PSA/CGC/BGS/SGC-specific. PSA 10 / BGS 10 / CGC 10 /
  SGC 10 are never substituted for one another. Unsupported grades return
  `null` (never a substituted grade); interpolation happens only when explicitly
  enabled and is always labeled an estimate.
- **Source honesty:** every value is labeled a *current market estimate* — never
  an eBay last-sold or historical sale.
- **Rate limits:** centralized limiter makes exceeding 1/s (standard),
  1/10-min (CSV), or 1/5-min (per-URL offers) structurally impossible.
- **Safety:** publish/edit/ship/feedback/end require `confirm: true`; refunds
  require `confirm_refund: true`. Buyer PII, tokens, tracking numbers, and SKUs
  are masked in all logs.

See [`VERIFICATION.md`](./VERIFICATION.md) for the full endpoint/function/test
matrix, subscription-gated features, and documented assumptions.
