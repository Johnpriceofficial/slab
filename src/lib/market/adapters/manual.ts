/**
 * Manual verified-comp adapter. An operator-entered sale (a comp they trust)
 * becomes a verified sale candidate. No network — it maps a form input directly,
 * so it has no fetch, only a pure map.
 */

import type { RawCandidate } from "../types";
import { buildProvenance, type SourceProvenance } from "../provenance";

export interface ManualComp {
  title?: string | null;
  price_cents: number;
  sold_at?: string | null;
  currency?: string | null;
  url?: string | null;
  grader?: string | null;
  grade?: string | null;
  grade_label?: string | null;
}

/** Pure: manual comps → verified sale candidates (unpriced entries dropped). */
export function mapManualComps(comps: ManualComp[], retrievedAt: string): RawCandidate[] {
  return comps
    .filter((c) => typeof c.price_cents === "number" && c.price_cents > 0)
    .map((c) => ({
      source: "manual" as const,
      title: c.title ?? null,
      price_cents: Math.round(c.price_cents),
      currency: (c.currency ?? "USD").toUpperCase(),
      url: c.url ?? null,
      sold: true,
      sold_at: c.sold_at ?? retrievedAt,
      observed_at: retrievedAt,
      grader: c.grader ?? null,
      grade: c.grade ?? null,
      grade_label: c.grade_label ?? null,
    }));
}

export function manualProvenance(comps: ManualComp[], retrievedAt: string): SourceProvenance {
  return buildProvenance({ source: "manual", query: "operator-entered", retrieved_at: retrievedAt, candidate_count: comps.length, exact_count: 0 });
}
