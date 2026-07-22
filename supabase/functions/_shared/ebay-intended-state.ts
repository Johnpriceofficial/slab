// Durable, VERSIONED intended-listing state + image manifest, plus a canonical
// SHA-256 fingerprint over both. This is the single source of truth for "what we
// intend to list" and "which exact local images back it" — persisted on the
// listing intent so a retry or reconcile compares against the EXACT prepared
// state rather than trusting a request body or a signed URL.
//
// Everything here is pure + cross-runtime (Web Crypto only), so it is unit-tested
// from src/test/ebay without a live connection. It NEVER contains signed URLs,
// tokens, auth headers, OAuth codes/states, encrypted credentials, raw provider
// responses/requests, buyer PII, or seller financial payloads — only canonical
// sanitized listing inputs and stable local image evidence (role, path, hash).

export const INTENDED_STATE_VERSION = 1;
export const IMAGE_MANIFEST_VERSION = 1;
// The fingerprint algorithm version. v3 = SHA-256 over the canonical intended
// state + image manifest (v2 was a weak `JSON.stringify` serialization).
export const LISTING_FINGERPRINT_VERSION = 3;

export interface IntendedStateV1 {
  version: 1;
  sku: string;
  marketplaceId: string;
  format: "FIXED_PRICE";
  categoryId: string;
  merchantLocationKey: string;
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
  price: string;            // normalized to exactly 2 decimal places
  currency: string;
  availableQuantity: number; // non-negative safe integer
  listingDescription: string;
  title: string;
  description: string;
  condition: string;
  conditionDescription: string;
  conditionDescriptors: string[];        // canonical, sorted
  aspects: Record<string, string[]>;     // keys + values canonical (values sorted)
}

export type ImageRole = "front" | "back";
export interface ManifestImage { role: ImageRole; path: string; sha256: string }
export interface ImageManifestV1 {
  version: 1;
  images: ManifestImage[];  // deterministic order: front, then back
  count: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isSafeNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const SHA256_HEX = /^[0-9a-f]{64}$/;

// Normalize a price to a stable 2dp string; returns null when not a positive finite number.
export function normalizePriceString(value: unknown): string | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toFixed(2);
}

// Canonicalize aspects into Record<string, string[]> with string keys, string
// values, and each value array SORTED (aspect value order is not semantically
// meaningful for a graded card). Non-string keys/values and empties are dropped.
export function canonicalAspects(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!isObj(raw)) return out;
  for (const key of Object.keys(raw)) {
    if (!nonEmptyStr(key)) continue;
    const v = raw[key];
    const values = (Array.isArray(v) ? v : [v]).filter(nonEmptyStr).map((s) => s);
    if (values.length > 0) out[key] = [...values].sort();
  }
  return out;
}

// Canonicalize condition descriptors to a sorted string[] (name=value1,value2).
export function canonicalDescriptors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((d) => {
      if (nonEmptyStr(d)) return d;
      if (isObj(d)) {
        const name = typeof d.name === "string" ? d.name : "";
        const values = Array.isArray(d.values) ? d.values.filter(nonEmptyStr) : [];
        return name ? `${name}=${[...values].sort().join(",")}` : "";
      }
      return "";
    })
    .filter(nonEmptyStr)
    .sort();
}

export interface IntendedStateInput {
  sku: string;
  marketplaceId: string;
  categoryId: string;
  merchantLocationKey: string;
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
  price: number;
  currency: string;
  availableQuantity: number;
  listingDescription: string;
  title: string;
  description: string;
  condition: string;
  conditionDescription: string;
  conditionDescriptors?: unknown;
  aspects?: unknown;
}

/** Build the canonical durable intended state from already-validated handler
 *  inputs. Returns null if any structurally-required field is invalid (the
 *  handler treats null as a 400/500 before it ever writes an intent). */
export function buildIntendedState(input: IntendedStateInput): IntendedStateV1 | null {
  const price = normalizePriceString(input.price);
  if (price === null) return null;
  if (!isSafeNonNegInt(input.availableQuantity)) return null;
  if (!nonEmptyStr(input.sku) || !nonEmptyStr(input.marketplaceId) || !nonEmptyStr(input.categoryId)) return null;
  if (!nonEmptyStr(input.merchantLocationKey) || !nonEmptyStr(input.fulfillmentPolicyId) || !nonEmptyStr(input.paymentPolicyId) || !nonEmptyStr(input.returnPolicyId)) return null;
  if (!nonEmptyStr(input.currency) || !nonEmptyStr(input.title) || !nonEmptyStr(input.condition)) return null;
  return {
    version: 1,
    sku: input.sku,
    marketplaceId: input.marketplaceId,
    format: "FIXED_PRICE",
    categoryId: input.categoryId,
    merchantLocationKey: input.merchantLocationKey,
    fulfillmentPolicyId: input.fulfillmentPolicyId,
    paymentPolicyId: input.paymentPolicyId,
    returnPolicyId: input.returnPolicyId,
    price,
    currency: input.currency,
    availableQuantity: input.availableQuantity,
    listingDescription: input.listingDescription ?? "",
    title: input.title,
    description: input.description ?? "",
    condition: input.condition,
    conditionDescription: input.conditionDescription ?? "",
    conditionDescriptors: canonicalDescriptors(input.conditionDescriptors),
    aspects: canonicalAspects(input.aspects),
  };
}

/** Build the image manifest from ordered {role, path, sha256} evidence. Returns
 *  null when any image is malformed or the front image is absent. */
export function buildImageManifest(images: Array<{ role: ImageRole; path: string; sha256: string }>): ImageManifestV1 | null {
  if (!Array.isArray(images) || images.length === 0) return null;
  const cleaned: ManifestImage[] = [];
  for (const img of images) {
    if (!img || (img.role !== "front" && img.role !== "back")) return null;
    if (!nonEmptyStr(img.path) || !SHA256_HEX.test(img.sha256)) return null;
    cleaned.push({ role: img.role, path: img.path, sha256: img.sha256 });
  }
  if (cleaned[0].role !== "front") return null; // front must lead
  return { version: 1, images: cleaned, count: cleaned.length };
}

/** Strict, versioned parser for a stored intended_state snapshot. A malformed or
 *  wrong-version snapshot returns null → the caller fails closed with
 *  `invalid_intended_state` and NEVER silently coerces. */
export function parseIntendedState(raw: unknown): IntendedStateV1 | null {
  if (!isObj(raw) || raw.version !== INTENDED_STATE_VERSION) return null;
  const s = raw as Record<string, unknown>;
  if (s.format !== "FIXED_PRICE") return null;
  for (const k of ["sku", "marketplaceId", "categoryId", "merchantLocationKey", "fulfillmentPolicyId", "paymentPolicyId", "returnPolicyId", "price", "currency", "title", "condition"] as const) {
    if (!nonEmptyStr(s[k])) return null;
  }
  for (const k of ["listingDescription", "description", "conditionDescription"] as const) {
    if (typeof s[k] !== "string") return null;
  }
  if (normalizePriceString(s.price) !== s.price) return null; // stored price must already be canonical 2dp
  if (!isSafeNonNegInt(s.availableQuantity)) return null;
  if (!Array.isArray(s.conditionDescriptors) || !s.conditionDescriptors.every(nonEmptyStr)) return null;
  if (!isObj(s.aspects)) return null;
  const aspects: Record<string, string[]> = {};
  for (const key of Object.keys(s.aspects)) {
    const v = (s.aspects as Record<string, unknown>)[key];
    if (!nonEmptyStr(key) || !Array.isArray(v) || !v.every(nonEmptyStr)) return null;
    aspects[key] = v as string[];
  }
  return {
    version: 1,
    sku: s.sku as string,
    marketplaceId: s.marketplaceId as string,
    format: "FIXED_PRICE",
    categoryId: s.categoryId as string,
    merchantLocationKey: s.merchantLocationKey as string,
    fulfillmentPolicyId: s.fulfillmentPolicyId as string,
    paymentPolicyId: s.paymentPolicyId as string,
    returnPolicyId: s.returnPolicyId as string,
    price: s.price as string,
    currency: s.currency as string,
    availableQuantity: s.availableQuantity as number,
    listingDescription: s.listingDescription as string,
    title: s.title as string,
    description: s.description as string,
    condition: s.condition as string,
    conditionDescription: s.conditionDescription as string,
    conditionDescriptors: (s.conditionDescriptors as string[]).slice(),
    aspects,
  };
}

/** Strict, versioned parser for a stored image_manifest snapshot. */
export function parseImageManifest(raw: unknown): ImageManifestV1 | null {
  if (!isObj(raw) || raw.version !== IMAGE_MANIFEST_VERSION) return null;
  const m = raw as Record<string, unknown>;
  if (!Array.isArray(m.images) || m.images.length === 0) return null;
  if (!isSafeNonNegInt(m.count) || m.count !== m.images.length) return null;
  const images: ManifestImage[] = [];
  for (const img of m.images) {
    if (!isObj(img) || (img.role !== "front" && img.role !== "back")) return null;
    if (!nonEmptyStr(img.path) || typeof img.sha256 !== "string" || !SHA256_HEX.test(img.sha256)) return null;
    images.push({ role: img.role as ImageRole, path: img.path as string, sha256: img.sha256 as string });
  }
  if (images[0].role !== "front") return null;
  return { version: 1, images, count: images.length };
}

// Deterministic canonical JSON: object keys are emitted in sorted order at every
// depth so key order never changes the serialization (arrays keep their order —
// value ordering is normalized upstream in build*/canonical* where meaningful).
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * THE canonical listing fingerprint: a SHA-256 over the fingerprint version, the
 * complete canonical intended state, and the complete canonical image manifest.
 * Order-stable (key sorting), signed-URL-free (the manifest holds only paths +
 * byte hashes), timestamp-free, and secret-free. Identical semantic state →
 * identical hash; any meaningful listing-input or image-hash change → different
 * hash. Returns a 64-char lowercase hex digest.
 */
export function canonicalListingFingerprint(state: IntendedStateV1, manifest: ImageManifestV1): Promise<string> {
  const payload = `v${LISTING_FINGERPRINT_VERSION}|state:${stableStringify(state)}|images:${stableStringify(manifest)}`;
  return sha256Hex(payload);
}
