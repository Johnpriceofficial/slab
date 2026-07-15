/**
 * Historical snapshot comparison — the basis for 30/90-day trends. A snapshot is
 * a point-in-time market reading; comparing two yields the delta, percent change,
 * and trend direction. Pure: all timestamps are supplied.
 */

export interface MarketSnapshot {
  taken_at: string;
  median_cents: number | null;
  sale_count: number;
}

export type TrendDirection = "up" | "down" | "flat";

export interface SnapshotComparison {
  from_at: string;
  to_at: string;
  delta_cents: number | null;
  percent_change: number | null;
  trend: TrendDirection;
}

/** Flat when the move is within this fraction of the earlier value. */
export const FLAT_THRESHOLD = 0.02;

export function compareSnapshots(previous: MarketSnapshot, current: MarketSnapshot): SnapshotComparison {
  const base = { from_at: previous.taken_at, to_at: current.taken_at };
  if (previous.median_cents === null || current.median_cents === null) {
    return { ...base, delta_cents: null, percent_change: null, trend: "flat" };
  }
  const delta = current.median_cents - previous.median_cents;
  const percent = previous.median_cents === 0 ? null : delta / previous.median_cents;
  const trend: TrendDirection = percent === null || Math.abs(percent) < FLAT_THRESHOLD ? "flat" : percent > 0 ? "up" : "down";
  return { ...base, delta_cents: delta, percent_change: percent, trend };
}

/** Build a snapshot from a summarized median + count at a given time. */
export function snapshotOf(takenAt: string, medianCents: number | null, saleCount: number): MarketSnapshot {
  return { taken_at: takenAt, median_cents: medianCents, sale_count: saleCount };
}
