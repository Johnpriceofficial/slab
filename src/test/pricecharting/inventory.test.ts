import { describe, it, expect } from "vitest";
import {
  calculateInventoryValue,
  calculateCollectionValue,
  calculateCostBasis,
  calculateRecoveredAmount,
  calculateUnrecoveredCost,
  calculateProfitLoss,
  calculateRecoveryPercentage,
  calculateProjectedProfit,
  buildInventoryReport,
} from "@/lib/pricecharting/inventory";
import type { InventoryItem, SoldOffer } from "@/lib/pricecharting/types";

const items: InventoryItem[] = [
  {
    sku: "A",
    quantity: 10,
    quantity_remaining: 7,
    purchase_cost_per_unit_pennies: 500, // $5
    current_value_per_unit_pennies: 800, // $8
  },
];

const sold: SoldOffer[] = [
  { offer_id: "1", sale_price_pennies: 900, cost_basis_pennies: 500 },
  { offer_id: "2", sale_price_pennies: 900, cost_basis_pennies: 500 },
  { offer_id: "3", sale_price_pennies: 900, cost_basis_pennies: 500 },
];

describe("inventory — core formulas", () => {
  it("total cost basis = quantity × unit cost", () => {
    expect(calculateCostBasis(items)).toBe(5000);
  });

  it("inventory value uses remaining units only", () => {
    expect(calculateInventoryValue(items)).toBe(5600); // 7 × 800
  });

  it("collection value uses all units", () => {
    expect(calculateCollectionValue(items)).toBe(8000); // 10 × 800
  });

  it("recovered amount sums actual sold proceeds", () => {
    expect(calculateRecoveredAmount(sold)).toBe(2700);
  });

  it("unrecovered cost never goes below zero", () => {
    expect(calculateUnrecoveredCost(5000, 2700)).toBe(2300);
    expect(calculateUnrecoveredCost(1000, 5000)).toBe(0);
  });

  it("profit/loss is recovered minus cost basis", () => {
    expect(calculateProfitLoss(5000, 2700)).toBe(-2300);
  });

  it("recovery percentage is (recovered / cost basis) × 100", () => {
    expect(calculateRecoveryPercentage(5000, 2700)).toBe(54);
  });

  it("recovery percentage is null (not Infinity) when cost basis is zero", () => {
    expect(calculateRecoveryPercentage(0, 2700)).toBeNull();
  });

  it("projected profit = recovered + inventory value − cost basis", () => {
    expect(calculateProjectedProfit(5600, 2700, 5000)).toBe(3300);
  });
});

describe("inventory — full report (partial inventory sold)", () => {
  it("keeps realized / unrealized / projected strictly separate", () => {
    const report = buildInventoryReport(items, sold);
    expect(report.total_cost_basis_pennies).toBe(5000);
    expect(report.current_inventory_value_pennies).toBe(5600);
    expect(report.recovered_amount_pennies).toBe(2700);
    expect(report.unrecovered_cost_pennies).toBe(2300);
    expect(report.realized_profit_loss_pennies).toBe(1200); // 2700 − (3×500)
    expect(report.unrealized_value_pennies).toBe(5600);
    expect(report.projected_total_return_pennies).toBe(8300);
    expect(report.projected_profit_loss_pennies).toBe(3300);
    expect(report.recovery_percentage).toBe(54);
    // Dollars mirror the penny figures.
    expect(report.dollars.recovered_amount).toBe(27);
    expect(report.dollars.projected_profit_loss).toBe(33);
  });

  it("does not count unsold inventory as recovered cash", () => {
    const report = buildInventoryReport(items, []);
    expect(report.recovered_amount_pennies).toBe(0);
    expect(report.current_inventory_value_pennies).toBe(5600);
    expect(report.recovery_percentage).toBe(0);
  });

  it("handles a zero-cost-basis collection without dividing by zero", () => {
    const free: InventoryItem[] = [
      { quantity: 2, purchase_cost_per_unit_pennies: 0, current_value_per_unit_pennies: 1000 },
    ];
    const report = buildInventoryReport(free, [{ offer_id: "x", sale_price_pennies: 1500 }]);
    expect(report.recovery_percentage).toBeNull();
    expect(report.projected_profit_loss_pennies).toBe(3500); // 1500 + 2000 − 0
  });

  it("treats a missing current value as unknown (0 contribution), not zero worth", () => {
    const unknown: InventoryItem[] = [
      { quantity: 1, purchase_cost_per_unit_pennies: 500, current_value_per_unit_pennies: null },
    ];
    expect(calculateInventoryValue(unknown)).toBe(0);
  });
});
