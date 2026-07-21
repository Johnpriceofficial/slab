/**
 * Source provenance. Every market figure records where it came from, the query
 * that produced it, when it was retrieved, and how many raw candidates the
 * source returned — so a value is always attributable and auditable.
 */

import type { MarketSource } from "./types";

export interface SourceProvenance {
  source: MarketSource;
  /** The exact query string sent to the source. */
  query: string;
  /** ISO timestamp the data was retrieved (passed in — never Date.now here). */
  retrieved_at: string;
  /** How many raw candidates the source returned (before classification). */
  candidate_count: number;
  /** How many survived as exact matches. */
  exact_count: number;
  url: string | null;
}

export function buildProvenance(input: {
  source: MarketSource;
  query: string;
  retrieved_at: string;
  candidate_count: number;
  exact_count: number;
  url?: string | null;
}): SourceProvenance {
  return {
    source: input.source,
    query: input.query,
    retrieved_at: input.retrieved_at,
    candidate_count: input.candidate_count,
    exact_count: input.exact_count,
    url: input.url ?? null,
  };
}

/** True when a source contributed at least one exact match. */
export function contributed(p: SourceProvenance): boolean {
  return p.exact_count > 0;
}
