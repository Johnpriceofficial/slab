/**
 * High-level facade. Construct once with `createPriceChartingService(deps)` and
 * call the bound methods. This is the recommended entry point for applications;
 * it wires a single rate-limited, cached, audited client into every operation.
 */

import { PriceChartingClient, type ClientDeps } from "./client";
import { searchProducts, getProductById, getProductByUPC } from "./api";
import { findBestProductMatch } from "./matching";
import {
  getProductValuation,
  getCardValuation,
  getVideoGameValuation,
  getComicValuation,
  getCoinValuation,
  getValuesForAllConditions,
  type ValuationOptions,
} from "./valuation";
import {
  listMarketplaceOffers,
  listSoldMarketplaceOffers,
  getOfferDetails,
  publishOffer,
  editOffer,
  markOfferShipped,
  leaveOfferFeedback,
  endOffer,
  refundOffer,
} from "./marketplace";
import {
  buildInventoryReport,
  calculateInventoryValue,
  calculateCollectionValue,
  calculateCostBasis,
  calculateRecoveredAmount,
  calculateUnrecoveredCost,
  calculateProfitLoss,
  calculateRecoveryPercentage,
  calculateProjectedProfit,
} from "./inventory";
import type {
  CardItemInput,
  CoinItemInput,
  ComicItemInput,
  FeedbackRating,
  InventoryItem,
  ItemInput,
  OfferFilters,
  PublishOfferInput,
  SoldOffer,
  VideoGameItemInput,
} from "./types";

export interface PriceChartingService {
  readonly client: PriceChartingClient;

  // Product reads / matching
  searchProducts(query: string): ReturnType<typeof searchProducts>;
  getProductById(id: string): ReturnType<typeof getProductById>;
  getProductByUPC(upc: string): ReturnType<typeof getProductByUPC>;
  findBestProductMatch(item: ItemInput): ReturnType<typeof findBestProductMatch>;

  // Valuation
  getProductValuation(item: ItemInput, opts?: ValuationOptions): ReturnType<typeof getProductValuation>;
  getCardValuation(item: CardItemInput, opts?: ValuationOptions): ReturnType<typeof getCardValuation>;
  getVideoGameValuation(item: VideoGameItemInput, opts?: ValuationOptions): ReturnType<typeof getVideoGameValuation>;
  getComicValuation(item: ComicItemInput, opts?: ValuationOptions): ReturnType<typeof getComicValuation>;
  getCoinValuation(item: CoinItemInput, opts?: ValuationOptions): ReturnType<typeof getCoinValuation>;
  getValuesForAllConditions(
    productId: string,
    category?: Parameters<typeof getValuesForAllConditions>[2],
  ): ReturnType<typeof getValuesForAllConditions>;

  // Marketplace
  listMarketplaceOffers(filters?: OfferFilters): ReturnType<typeof listMarketplaceOffers>;
  listSoldMarketplaceOffers(filters?: Omit<OfferFilters, "status">): ReturnType<typeof listSoldMarketplaceOffers>;
  getOfferDetails(offerId: string): ReturnType<typeof getOfferDetails>;
  publishOffer(input: PublishOfferInput): ReturnType<typeof publishOffer>;
  editOffer(offerId: string, updates: Omit<PublishOfferInput, "offer-id">): ReturnType<typeof editOffer>;
  markOfferShipped(offerId: string, trackingNumber?: string, confirm?: boolean): ReturnType<typeof markOfferShipped>;
  leaveOfferFeedback(offerId: string, rating: FeedbackRating, comment?: string): ReturnType<typeof leaveOfferFeedback>;
  endOffer(offerId: string, confirmation: { confirm: boolean }): ReturnType<typeof endOffer>;
  refundOffer(offerId: string, confirmation: { confirm_refund: boolean }): ReturnType<typeof refundOffer>;

  // Inventory (pure)
  buildInventoryReport(items: InventoryItem[], soldOffers: SoldOffer[]): ReturnType<typeof buildInventoryReport>;
  calculateInventoryValue: typeof calculateInventoryValue;
  calculateCollectionValue: typeof calculateCollectionValue;
  calculateCostBasis: typeof calculateCostBasis;
  calculateRecoveredAmount: typeof calculateRecoveredAmount;
  calculateUnrecoveredCost: typeof calculateUnrecoveredCost;
  calculateProfitLoss: typeof calculateProfitLoss;
  calculateRecoveryPercentage: typeof calculateRecoveryPercentage;
  calculateProjectedProfit: typeof calculateProjectedProfit;
}

/** Create a fully-wired service. Pass ClientDeps to inject fetch/clock/token in tests. */
export function createPriceChartingService(deps: ClientDeps = {}): PriceChartingService {
  const client = new PriceChartingClient(deps);
  return {
    client,

    searchProducts: (q) => searchProducts(client, q),
    getProductById: (id) => getProductById(client, id),
    getProductByUPC: (upc) => getProductByUPC(client, upc),
    findBestProductMatch: (item) => findBestProductMatch(client, item),

    getProductValuation: (item, opts) => getProductValuation(client, item, opts),
    getCardValuation: (item, opts) => getCardValuation(client, item, opts),
    getVideoGameValuation: (item, opts) => getVideoGameValuation(client, item, opts),
    getComicValuation: (item, opts) => getComicValuation(client, item, opts),
    getCoinValuation: (item, opts) => getCoinValuation(client, item, opts),
    getValuesForAllConditions: (productId, category) => getValuesForAllConditions(client, productId, category),

    listMarketplaceOffers: (filters) => listMarketplaceOffers(client, filters),
    listSoldMarketplaceOffers: (filters) => listSoldMarketplaceOffers(client, filters),
    getOfferDetails: (offerId) => getOfferDetails(client, offerId),
    publishOffer: (input) => publishOffer(client, input),
    editOffer: (offerId, updates) => editOffer(client, offerId, updates),
    markOfferShipped: (offerId, tracking, confirm) => markOfferShipped(client, offerId, tracking, confirm),
    leaveOfferFeedback: (offerId, rating, comment) => leaveOfferFeedback(client, offerId, rating, comment),
    endOffer: (offerId, confirmation) => endOffer(client, offerId, confirmation),
    refundOffer: (offerId, confirmation) => refundOffer(client, offerId, confirmation),

    buildInventoryReport,
    calculateInventoryValue,
    calculateCollectionValue,
    calculateCostBasis,
    calculateRecoveredAmount,
    calculateUnrecoveredCost,
    calculateProfitLoss,
    calculateRecoveryPercentage,
    calculateProjectedProfit,
  };
}
