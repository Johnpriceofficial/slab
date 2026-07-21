// Pure, cross-runtime shaping for eBay order and finance sync. No Deno/npm
// imports, so the money parsing, slab-mapping resolution, sale-proposal
// derivation, and finance-transaction shaping are unit-tested from src/test/ebay
// without a live eBay connection or database. The Edge function fetches raw
// provider payloads + the SKU→slab mapping, calls these, and hands the shaped
// rows to the SECURITY DEFINER apply RPCs.

export function moneyCents(money: unknown): number | null {
  if (!money || typeof money !== "object") return null;
  const value = Number((money as Record<string, unknown>).value);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

export interface ShapedLineItem {
  line_item_id: string;
  slab_id: string | null;
  sku: string;
  listing_id: string | null;
  quantity: number;
  line_total: unknown;
  raw_response: Record<string, unknown>;
  sold_price_cents: number | null;
  currency: string;
  sold_at: string | null;
  external_sale_id: string;
}

export interface ShapedOrder {
  order_id: string;
  order_status: string;
  buyer_data: Record<string, unknown>;
  pricing_summary: Record<string, unknown>;
  raw_response: Record<string, unknown>;
  line_items: ShapedLineItem[];
}

// A line item that maps to a slab AND carries a real sold amount — i.e. one that
// APPLY_SALES would move to "sold". This is exactly what the audit preview lists.
export interface ProposedSale {
  order_id: string;
  line_item_id: string;
  slab_id: string;
  sku: string;
  sold_price_cents: number;
  currency: string;
}

export interface ShapedOrders {
  shaped: ShapedOrder[];
  proposed_sales: ProposedSale[];
  order_count: number;
  line_item_count: number;
}

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});
const asArr = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v as Array<Record<string, unknown>> : []);
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/**
 * Shape raw eBay orders into apply-ready rows and derive the sales an
 * APPLY_SALES run would perform. `mappingBySku` maps a listing SKU to the slab
 * it represents (empty when a SKU is not one of ours). Pure: no writes, no I/O.
 */
export function shapeEbayOrders(rawOrders: unknown, mappingBySku: ReadonlyMap<string, string>): ShapedOrders {
  const shaped: ShapedOrder[] = [];
  const proposed: ProposedSale[] = [];
  let lineItemCount = 0;

  for (const raw of asArr(rawOrders)) {
    const orderId = str(raw.orderId);
    if (!orderId) continue;
    const soldAt = str(raw.creationDate) || null;
    const lineItems: ShapedLineItem[] = [];

    for (const line of asArr(raw.lineItems)) {
      const lineItemId = str(line.lineItemId);
      if (!lineItemId) continue;
      const sku = str(line.sku);
      const slabId = (sku && mappingBySku.get(sku)) || null;
      const soldCents = moneyCents(line.lineItemCost);
      const currency = str(asObj(line.lineItemCost).currency) || "USD";
      const externalSaleId = `${orderId}:${lineItemId}`;
      lineItems.push({
        line_item_id: lineItemId,
        slab_id: slabId,
        sku,
        listing_id: line.legacyItemId != null ? str(line.legacyItemId) : null,
        quantity: Number.isFinite(Number(line.quantity)) ? Number(line.quantity) : 1,
        line_total: line.lineItemCost ?? null,
        raw_response: asObj(line),
        sold_price_cents: soldCents,
        currency,
        sold_at: soldAt,
        external_sale_id: externalSaleId,
      });
      lineItemCount += 1;
      if (slabId && soldCents !== null) {
        proposed.push({ order_id: orderId, line_item_id: lineItemId, slab_id: slabId, sku, sold_price_cents: soldCents, currency });
      }
    }

    shaped.push({
      order_id: orderId,
      order_status: str(raw.orderFulfillmentStatus) || str(raw.orderPaymentStatus) || "UNKNOWN",
      buyer_data: { buyer: raw.buyer ?? null, fulfillmentStartInstructions: raw.fulfillmentStartInstructions ?? null },
      pricing_summary: asObj(raw.pricingSummary),
      raw_response: asObj(raw),
      line_items: lineItems,
    });
  }

  return { shaped, proposed_sales: proposed, order_count: shaped.length, line_item_count: lineItemCount };
}

// Every distinct, non-empty SKU across the orders — the exact set to look up in
// ebay_listing_mappings so the mapping query is one batched call, not one per line.
export function skusFromOrders(rawOrders: unknown): string[] {
  const set = new Set<string>();
  for (const raw of asArr(rawOrders)) {
    for (const line of asArr(raw.lineItems)) {
      const sku = str(line.sku);
      if (sku) set.add(sku);
    }
  }
  return [...set];
}

export interface ShapedTransaction {
  transaction_id: string;
  order_id: string | null;
  transaction_type: string;
  transaction_status: string;
  amount: unknown;
  fee_basis_amount: unknown;
  raw_response: Record<string, unknown>;
  occurred_at: string | null;
}

/**
 * Shape raw eBay finance transactions into idempotent-upsert rows. Unknown enum
 * / CustomCode values survive in raw_response; nothing is dropped. Pure.
 */
export function shapeEbayFinanceTransactions(rawTransactions: unknown): ShapedTransaction[] {
  const out: ShapedTransaction[] = [];
  for (const raw of asArr(rawTransactions)) {
    const transactionId = str(raw.transactionId);
    if (!transactionId) continue;
    out.push({
      transaction_id: transactionId,
      order_id: raw.orderId != null ? str(raw.orderId) : null,
      transaction_type: str(raw.transactionType) || "UNKNOWN",
      transaction_status: str(raw.transactionStatus) || "UNKNOWN",
      amount: raw.amount ?? null,
      fee_basis_amount: raw.totalFeeBasisAmount ?? null,
      raw_response: asObj(raw),
      occurred_at: str(raw.transactionDate) || str(raw.bookingEntry) || null,
    });
  }
  return out;
}
