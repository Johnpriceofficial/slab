/**
 * Shared adapter runner: one place for HTTP status handling, parse-error
 * isolation, and network-error capture, so every adapter maps consistently and
 * a provider failure becomes a typed AdapterError rather than a throw.
 */

import type { MarketSource, RawCandidate } from "../types";
import { buildProvenance } from "../provenance";
import type { AdapterContext, AdapterResult } from "./types";
import { httpStatusToError } from "./types";

export async function runAdapter(
  source: MarketSource,
  query: string,
  ctx: AdapterContext,
  request: { url: string; headers?: Record<string, string> },
  map: (body: unknown, retrievedAt: string) => RawCandidate[],
): Promise<AdapterResult> {
  const base = { source, query, retrieved_at: ctx.retrieved_at, exact_count: 0 };
  try {
    const res = await ctx.fetch(request);
    if (!res.ok) {
      return { source, candidates: [], provenance: buildProvenance({ ...base, candidate_count: 0 }), error: httpStatusToError(source, res.status) };
    }
    let candidates: RawCandidate[];
    try {
      candidates = map(res.body, ctx.retrieved_at);
    } catch (e) {
      return { source, candidates: [], provenance: buildProvenance({ ...base, candidate_count: 0 }), error: { source, code: "parse_error", message: e instanceof Error ? e.message : "Unreadable response.", retryable: false } };
    }
    return { source, candidates, provenance: buildProvenance({ ...base, candidate_count: candidates.length }), error: null };
  } catch (e) {
    return { source, candidates: [], provenance: buildProvenance({ ...base, candidate_count: 0 }), error: { source, code: "network_error", message: e instanceof Error ? e.message : "Request failed.", retryable: true } };
  }
}
