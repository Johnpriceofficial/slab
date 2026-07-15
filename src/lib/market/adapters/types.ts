/**
 * Live-source adapter contracts.
 *
 * An adapter is the ONLY place that knows a provider's response shape. It maps a
 * provider response into normalized RawCandidates and never classifies,
 * summarizes, or touches the database. The strict pipeline is:
 *
 *   provider response → adapter → RawCandidate[] → classifier → summary
 *
 * The network call is injected (AdapterFetch) so the mapping is pure and tested
 * with fixtures; live wiring supplies a real fetch. Timestamps are supplied
 * (retrieved_at), never read from the wall clock, so results are deterministic.
 */

import type { MarketSource, RawCandidate } from "../types";
import type { SourceProvenance } from "../provenance";

export type AdapterErrorCode =
  | "rate_limited"
  | "unauthorized"
  | "not_found"
  | "provider_error"
  | "parse_error"
  | "network_error";

export interface AdapterError {
  source: MarketSource;
  code: AdapterErrorCode;
  message: string;
  retryable: boolean;
}

export interface AdapterResult {
  source: MarketSource;
  /** Normalized candidates (unclassified — the classifier runs downstream). */
  candidates: RawCandidate[];
  provenance: SourceProvenance;
  /** Non-null when the fetch failed; candidates is then empty. */
  error: AdapterError | null;
}

/** A minimal, DOM-free HTTP response the adapter interprets. */
export interface AdapterHttpResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

/** Injected network call. Live code passes a real implementation; tests a fake. */
export type AdapterFetch = (request: { url: string; headers?: Record<string, string> }) => Promise<AdapterHttpResponse>;

export interface AdapterContext {
  fetch: AdapterFetch;
  /** Deterministic retrieval time stamped onto candidates + provenance. */
  retrieved_at: string;
}

/** Map an HTTP status to a typed adapter error (retryable set conservatively). */
export function httpStatusToError(source: MarketSource, status: number, message?: string): AdapterError {
  if (status === 401 || status === 403) return { source, code: "unauthorized", message: message ?? "Not authorized for this source.", retryable: false };
  if (status === 404) return { source, code: "not_found", message: message ?? "No data found.", retryable: false };
  if (status === 429) return { source, code: "rate_limited", message: message ?? "Rate limited by the source.", retryable: true };
  return { source, code: "provider_error", message: message ?? `Source returned HTTP ${status}.`, retryable: status >= 500 };
}
