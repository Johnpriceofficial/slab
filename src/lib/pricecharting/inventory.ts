/**
 * Inventory, cost-recovery, and profit calculations.
 *
 * ALL arithmetic is on integer pennies — no binary floating point. The only
 * float produced is `recovery_percentage`, which is a ratio for display and is
 * `null` (never Infinity) when the cost basis is zero.
 *
 * Conceptual separation is strict:
 *   - Cash recovered     = money actually received from sold items.
 *   - Inventory value    = current value of UNSOLD stock (not cash).
 *   - Realized P/L       = recovered - cost basis of the items that sold.
 *   - Unrealized value   = current value still held in inventory.
 *   - Projected profit   = (recovered + inventory value) - total cost basis.
 * Unsold inventory is NEVER counted as recovered cash.
 */

import { multiplyPennies, sumPennies, convertPenniesToDollars, type Pennies } from "./money";
import type { InventoryItem, InventoryReport, SoldOffer } from "./types";

function quantityRemaining(item: InventoryItem): number {
  const remaining = item.quantity_remaining ?? item.quantity;
  if (!Number.isInteger(remaining) || remaining < 0) {
    throw new Error(`Invalid quantity_remaining for item ${item.sku ?? item.name ?? "?"}: ${remaining}`);
  }
  return Math.min(remaining, item.quantity);
}

/**
 * Total current value of UNSOLD inventory: sum(quantity_remaining × current
 * value per unit). Items lacking a current value contribute 0 to the total but
 * their absence is the caller's to interpret (value is unknown, not zero worth).
 * Required core function #23.
 */
export function calculateInventoryValue(items: InventoryItem[]): Pennies {
  return sumPennies(
    items.map((item) => {
      const unit = item.current_value_per_unit_pennies ?? null;
      if (unit === null) return 0;
      return multiplyPennies(unit, quantityRemaining(item));
    }),
  );
}

/**
 * Total value of an entire collection: sum(quantity × current value per unit),
 * regardless of how many units remain unsold. Use for portfolio valuation.
 * Required core function #24.
 */
export function calculateCollectionValue(items: InventoryItem[]): Pennies {
  return sumPennies(
    items.map((item) => {
      const unit = item.current_value_per_unit_pennies ?? null;
      if (unit === null) return 0;
      return multiplyPennies(unit, item.quantity);
    }),
  );
}

/**
 * Total cost basis: sum(quantity × purchase cost per unit).
 * Required core function #25.
 */
export function calculateCostBasis(items: InventoryItem[]): Pennies {
  return sumPennies(items.map((item) => multiplyPennies(item.purchase_cost_per_unit_pennies, item.quantity)));
}

/**
 * Actual proceeds recovered from sold offers: sum(sale price + shipping
 * premium). Only genuinely-sold offers should be passed in.
 * Required core function #26.
 */
export function calculateRecoveredAmount(soldOffers: SoldOffer[]): Pennies {
  return sumPennies(
    soldOffers.map((o) => (o.sale_price_pennies ?? 0) + (o.shipping_premium_pennies ?? 0)),
  );
}

/**
 * Cost basis attributable to the items that actually sold. Uses each sold
 * offer's own cost basis × quantity when present; offers without a cost basis
 * contribute 0 (they cannot be allocated).
 */
export function calculateSoldCostBasis(soldOffers: SoldOffer[]): Pennies {
  return sumPennies(
    soldOffers.map((o) => (o.cost_basis_pennies === undefined ? 0 : multiplyPennies(o.cost_basis_pennies, o.quantity ?? 1))),
  );
}

/**
 * Remaining unrecovered cost = max(cost basis - recovered, 0).
 * Required core function #27.
 */
export function calculateUnrecoveredCost(costBasis: Pennies, recoveredAmount: Pennies): Pennies {
  return Math.max(costBasis - recoveredAmount, 0);
}

/**
 * Net profit/loss versus total cost basis = recovered - cost basis.
 * (For realized-only P/L, pass the cost basis allocated to sold items.)
 * Required core function #28.
 */
export function calculateProfitLoss(costBasis: Pennies, recoveredAmount: Pennies): Pennies {
  return recoveredAmount - costBasis;
}

/**
 * Recovery percentage = (recovered / cost basis) × 100.
 * Returns `null` — never Infinity — when cost basis is 0.
 * Required core function #29.
 */
export function calculateRecoveryPercentage(costBasis: Pennies, recoveredAmount: Pennies): number | null {
  if (costBasis === 0) return null;
  return Math.round((recoveredAmount / costBasis) * 10000) / 100; // 2 decimals
}

/**
 * Projected profit = (recovered + current inventory value) - cost basis.
 * Required core function #30.
 */
export function calculateProjectedProfit(
  currentInventoryValue: Pennies,
  recoveredAmount: Pennies,
  costBasis: Pennies,
): Pennies {
  return recoveredAmount + currentInventoryValue - costBasis;
}

/**
 * Assemble the full inventory + recovery report. Combines current inventory
 * items with realized sold offers, keeping realized / unrealized / projected
 * figures strictly separate.
 */
export function buildInventoryReport(items: InventoryItem[], soldOffers: SoldOffer[]): InventoryReport {
  const totalCostBasis = calculateCostBasis(items);
  const currentInventoryValue = calculateInventoryValue(items);
  const recovered = calculateRecoveredAmount(soldOffers);
  const soldCostBasis = calculateSoldCostBasis(soldOffers);

  const unrecovered = calculateUnrecoveredCost(totalCostBasis, recovered);
  const realized = recovered - soldCostBasis; // realized P/L on the sold items
  const unrealizedValue = currentInventoryValue; // value still held, not yet cash
  const projectedTotalReturn = recovered + currentInventoryValue;
  const projectedProfitLoss = projectedTotalReturn - totalCostBasis;
  const recoveryPct = calculateRecoveryPercentage(totalCostBasis, recovered);

  const d = (p: Pennies): number => convertPenniesToDollars(p) ?? 0;

  return {
    total_cost_basis_pennies: totalCostBasis,
    current_inventory_value_pennies: currentInventoryValue,
    recovered_amount_pennies: recovered,
    unrecovered_cost_pennies: unrecovered,
    realized_profit_loss_pennies: realized,
    unrealized_value_pennies: unrealizedValue,
    projected_total_return_pennies: projectedTotalReturn,
    projected_profit_loss_pennies: projectedProfitLoss,
    recovery_percentage: recoveryPct,
    dollars: {
      total_cost_basis: d(totalCostBasis),
      current_inventory_value: d(currentInventoryValue),
      recovered_amount: d(recovered),
      unrecovered_cost: d(unrecovered),
      realized_profit_loss: d(realized),
      unrealized_value: d(unrealizedValue),
      projected_total_return: d(projectedTotalReturn),
      projected_profit_loss: d(projectedProfitLoss),
    },
  };
}
