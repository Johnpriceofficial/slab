/**
 * Public-page adapter entry point: fetch → parse → verify → normalize → artwork,
 * assembled into a ProductPageSnapshot. Server-side only, gated behind the
 * feature flag, and it NEVER returns raw HTML. Pure sub-steps (parse/normalize/
 * verify/image) are fixture-tested; the network is injected.
 */

import { pageAdapterEnabled, type EnvGet } from "./flag";
import { fetchProductPage, type PageFetchDeps, type PageFetchOptions } from "./fetch";
import { parseProductPage } from "./parse";
import { verifyPageIdentity, type ExpectedIdentity } from "./verify";
import { normalizeTiers } from "./normalize";
import { extractArtwork } from "./image";
import { resolveTierSource, type TierSourceResolution } from "./merge";
import {
  PARSER_VERSION,
  SOURCE_VERSION,
  PUBLIC_PAGE_SOURCE,
  type ProductPageSnapshot,
  type PageAdapterState,
} from "./types";

export interface SnapshotDeps extends PageFetchDeps {
  /** ISO retrieval timestamp — injected, never read from a wall clock here. */
  now: () => string;
  /** Env accessor for the feature flag (Deno.env.get / process.env). */
  getEnv: EnvGet;
}

export interface SnapshotInput {
  product_id: string;
  canonical_url: string;
  expected: Omit<ExpectedIdentity, "product_id"> & { product_id?: string };
}

/** Safe, fixed user-facing message per terminal state — never raw provider text. */
function messageFor(state: PageAdapterState): string {
  switch (state) {
    case "success": return "Reference values read from the PriceCharting public product page.";
    case "no_exact_tier": return "The PriceCharting public page has no value for this exact tier.";
    case "product_mismatch": return "The PriceCharting page did not match the linked product; evidence was rejected.";
    case "parser_outdated": return "The PriceCharting page layout changed; the reader needs updating.";
    case "provider_blocked": return "PriceCharting is currently unavailable.";
    case "rate_limited": return "PriceCharting is rate-limiting requests; try again shortly.";
    case "network_error": return "Could not reach the PriceCharting public page.";
    case "invalid_html": return "The PriceCharting page could not be read.";
    case "image_unavailable": return "No reference artwork was available.";
    case "disabled": return "The PriceCharting public-page source is disabled.";
  }
}

function emptySnapshot(state: PageAdapterState, retrievedAt: string, product_id: string, canonical_url: string): ProductPageSnapshot {
  return {
    source: PUBLIC_PAGE_SOURCE,
    provider_id: "pricecharting",
    state,
    product_id,
    canonical_url,
    retrieved_at: retrievedAt,
    last_updated_text: null,
    parser_version: PARSER_VERSION,
    source_version: SOURCE_VERSION,
    identity_status: null,
    identity: { product_id: null, title: null, card_number: null, set_or_console: null, language: null, canonical_url: null },
    tiers: [],
    artwork: null,
    message: messageFor(state),
  };
}

export async function getProductPageSnapshot(input: SnapshotInput, deps: SnapshotDeps, options?: PageFetchOptions): Promise<ProductPageSnapshot> {
  const retrievedAt = deps.now();

  // FLAG GATE: disabled → return immediately, NO network fetch of any kind.
  if (!pageAdapterEnabled(deps.getEnv)) {
    return emptySnapshot("disabled", retrievedAt, input.product_id, input.canonical_url);
  }

  const fetched = await fetchProductPage(input.canonical_url, deps, options);
  if (fetched.state !== "success" || !fetched.html) {
    return emptySnapshot(fetched.state, retrievedAt, input.product_id, input.canonical_url);
  }

  const extract = parseProductPage(fetched.html);
  const verdict = verifyPageIdentity(extract, { ...input.expected, product_id: input.product_id });
  if (verdict.status === "REJECTED") {
    return emptySnapshot("product_mismatch", retrievedAt, input.product_id, input.canonical_url);
  }

  const tiers = normalizeTiers(extract.rows);
  const artwork = extractArtwork(extract);
  const state: PageAdapterState = tiers.some((t) => t.value_cents !== null) ? "success" : "no_exact_tier";

  return {
    source: PUBLIC_PAGE_SOURCE,
    provider_id: "pricecharting",
    state,
    product_id: input.product_id,
    canonical_url: input.canonical_url,
    retrieved_at: retrievedAt,
    last_updated_text: extract.last_updated_text,
    parser_version: PARSER_VERSION,
    source_version: SOURCE_VERSION,
    identity_status: verdict.status,
    identity: {
      product_id: extract.product_id,
      title: extract.title,
      card_number: extract.card_number,
      set_or_console: extract.set_or_console,
      language: extract.set_or_console,
      canonical_url: extract.canonical_url,
    },
    tiers,
    artwork,
    message: messageFor(state),
  };
}

/** Look up one canonical tier's cents from a snapshot (null when absent). */
export function pageTierCents(snapshot: ProductPageSnapshot, tier: string): number | null {
  const found = snapshot.tiers.find((t) => t.tier === tier);
  return found ? found.value_cents : null;
}

/**
 * The COMPLETE normalized snapshot as a tier→cents map, so the UI can populate
 * Compare-Other-Grades, Market Intelligence, upgrade/downgrade, insurance values,
 * and future price history from ONE fetch — never re-fetching per tier.
 */
export function snapshotTierMap(snapshot: ProductPageSnapshot): Record<string, number | null> {
  const map: Record<string, number | null> = {};
  for (const t of snapshot.tiers) map[t.tier] = t.value_cents;
  return map;
}

/**
 * API-FIRST valuation for one graded tier. The public page is a FALLBACK: it is
 * consulted (and only then fetched) when — and only when — the official API
 * cannot supply the exact tier. This minimizes requests and keeps us on the
 * official API whenever it has the value.
 *
 *   API has exact tier  → use API, page is NEVER fetched.
 *   API missing tier    → fetch the page, use its VERIFIED exact tier.
 */
export async function valueGradedTierApiFirst(args: {
  tier: string;
  /** The exact API tier value already looked up, or null when the API lacks it. */
  api_cents: number | null;
  /** Deferred page fetch — only awaited on an API gap. */
  fetchPage: () => Promise<ProductPageSnapshot>;
}): Promise<{ resolution: TierSourceResolution; page_snapshot: ProductPageSnapshot | null }> {
  if (typeof args.api_cents === "number") {
    // Official API already has it — do NOT scrape.
    return {
      resolution: resolveTierSource({ api_cents: args.api_cents, page_cents: null, page_identity_verified: false }),
      page_snapshot: null,
    };
  }
  // API gap → NOW consult the public page.
  const snapshot = await args.fetchPage();
  const page_cents = pageTierCents(snapshot, args.tier);
  return {
    resolution: resolveTierSource({
      api_cents: null,
      page_cents,
      page_identity_verified: snapshot.identity_status === "VERIFIED",
    }),
    page_snapshot: snapshot,
  };
}

export * from "./types";
export * from "./url";
export * from "./parse";
export * from "./normalize";
export * from "./verify";
export * from "./image";
export * from "./cache";
export * from "./flag";
export * from "./merge";
export * from "./provider";
export * from "./tier";
export { fetchProductPage, resetPageBreaker } from "./fetch";
export type { PageFetch, PageFetchDeps, PageFetchOptions, PageFetchResult } from "./fetch";
