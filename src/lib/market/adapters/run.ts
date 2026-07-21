/**
 * Shared adapter runner: one place for HTTP status handling, schema/parse-error
 * isolation, and network-error capture, so every current or future provider
 * degrades to a typed AdapterError rather than throwing into the page.
 */

import type { MarketSource, RawCandidate } from "../types";
import { buildProvenance } from "../provenance";
import type { AdapterContext, AdapterResult } from "./types";
import { httpStatusToError } from "./types";
import { ProviderSchemaError } from "@/lib/providers/response-schema";

function validateCandidates(source: MarketSource, value: unknown): RawCandidate[] {
  if (!Array.isArray(value)) throw new ProviderSchemaError(source, "$mapped", "adapter must return an array");
  return value.filter((candidate): candidate is RawCandidate => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const row = candidate as Record<string, unknown>;
    return row.source === source
      && (row.price_cents === null || row.price_cents === undefined
        || (typeof row.price_cents === "number" && Number.isFinite(row.price_cents)));
  });
}

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
      return {
        source,
        candidates: [],
        provenance: buildProvenance({ ...base, candidate_count: 0 }),
        error: httpStatusToError(source, res.status),
      };
    }
    try {
      const candidates = validateCandidates(source, map(res.body, ctx.retrieved_at));
      return {
        source,
        candidates,
        provenance: buildProvenance({ ...base, candidate_count: candidates.length }),
        error: null,
      };
    } catch (error) {
      return {
        source,
        candidates: [],
        provenance: buildProvenance({ ...base, candidate_count: 0 }),
        error: {
          source,
          code: "parse_error",
          message: error instanceof ProviderSchemaError
            ? `${source} returned data in an unsupported format.`
            : "Unreadable provider response.",
          retryable: false,
        },
      };
    }
  } catch {
    return {
      source,
      candidates: [],
      provenance: buildProvenance({ ...base, candidate_count: 0 }),
      error: { source, code: "network_error", message: "Request failed.", retryable: true },
    };
  }
}
