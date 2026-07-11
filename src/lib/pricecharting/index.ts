/**
 * PriceCharting integration — public API surface.
 *
 * Usage:
 *   import { createPriceChartingService } from "@/lib/pricecharting";
 *   const pc = createPriceChartingService(); // reads PRICECHARTING_API_TOKEN
 *   const valuation = await pc.getCardValuation({ ... });
 *
 * The token is read from the environment variable PRICECHARTING_API_TOKEN and is
 * never logged, returned, or stored in clear text.
 */

// Facade (recommended entry point)
export { createPriceChartingService, type PriceChartingService } from "./service";

// Client + DI types (for advanced use / testing)
export { PriceChartingClient, type ClientDeps, type FetchLike, type RequestOptions } from "./client";
export { systemClock, FakeClock, type Clock } from "./clock";
export { RateLimiter } from "./rate-limiter";
export { ResponseCache } from "./cache";

// Money
export {
  convertPenniesToDollars,
  convertDollarsToPennies,
  sumPennies,
  multiplyPennies,
  formatPennies,
  type Pennies,
} from "./money";

// Errors
export {
  PriceChartingError,
  isPriceChartingError,
  normalizeHttpError,
  NON_RETRYABLE_CODES,
  type PriceChartingErrorCode,
} from "./errors";

// Logging / privacy
export {
  sanitizeSensitiveData,
  maskValue,
  maskEmail,
  maskToken,
  createConsoleLogger,
  nullLogger,
  type Logger,
} from "./logger";

// Audit
export { createAuditLog, InMemoryAuditSink, type AuditEvent, type AuditRecord, type AuditSink } from "./audit";

// Product reads / matching
export { searchProducts, getProductById, getProductByUPC } from "./api";
export {
  findBestProductMatch,
  scoreCandidate,
  extractIdentifiers,
  buildSearchQuery,
  requiresHighConfidence,
} from "./matching";
export { normalizeProduct, normalizeProductList, KNOWN_PRICE_FIELDS } from "./product";

// Grade mapping
export {
  getValueForRequestedGrade,
  buildAvailableValues,
  categoryToPriceCategory,
  inferPriceCategoryFromProduct,
  type PriceCategory,
} from "./grade-mapping";

// Valuation
export {
  getProductValuation,
  getCardValuation,
  getVideoGameValuation,
  getComicValuation,
  getCoinValuation,
  getValuesForAllConditions,
  type ValuationOptions,
} from "./valuation";

// Marketplace
export {
  listMarketplaceOffers,
  listSoldMarketplaceOffers,
  getOfferDetails,
  publishOffer,
  editOffer,
  markOfferShipped,
  leaveOfferFeedback,
  endOffer,
  refundOffer,
  VALID_CONDITION_IDS,
} from "./marketplace";

// Inventory
export {
  buildInventoryReport,
  calculateInventoryValue,
  calculateCollectionValue,
  calculateCostBasis,
  calculateRecoveredAmount,
  calculateSoldCostBasis,
  calculateUnrecoveredCost,
  calculateProfitLoss,
  calculateRecoveryPercentage,
  calculateProjectedProfit,
} from "./inventory";

// Config
export { RATE_LIMITS, OFFER_LIMITS, TOKEN_ENV_VAR, PRICECHARTING_BASE_URL } from "./config";

// Types
export type * from "./types";
