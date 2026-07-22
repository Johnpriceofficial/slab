// Durable, VERSIONED intended-listing state + image manifest, plus a canonical
// SHA-256 fingerprint over both, plus a strict verifier that RECOMPUTES the
// fingerprint before any stored snapshot is trusted. This is the single source of
// truth for "what we intend to list" and "which exact local images back it".
//
// Everything here is pure + cross-runtime (Web Crypto only) → unit-tested from
// src/test/ebay without a live connection. It NEVER contains signed URLs, tokens,
// auth headers, OAuth codes/states, encrypted credentials, raw provider
// responses/requests, buyer PII, or seller financial payloads.
//
// The stored-state parsers are EXACT-SCHEMA and CANONICAL: a stored snapshot must
// already be canonical (no unknown fields, no noncanonical ordering, no
// duplicates) — a malformed/forged/noncanonical row fails closed. Object KEY order
// is intentionally NOT enforced (Postgres jsonb reorders object keys on storage);
// canonicalization for the fingerprint sorts keys, and ARRAY order (which jsonb
// preserves) IS enforced.

export const INTENDED_STATE_VERSION = 1;
export const IMAGE_MANIFEST_VERSION = 1;
// The fingerprint algorithm version. v3 = SHA-256 over intended state + manifest.
export const LISTING_FINGERPRINT_VERSION = 3;
export const EBAY_TITLE_MAX = 80;
export const MAX_QUANTITY = 999;
const SUPPORTED_CURRENCIES = new Set(["USD"]);

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
  availableQuantity: number; // integer within [1, MAX_QUANTITY]
  listingDescription: string;
  title: string;
  description: string;
  condition: string;
  conditionDescription: string;
  conditionDescriptors: string[];        // canonical: sorted ascending, no duplicates
  aspects: Record<string, string[]>;     // values sorted ascending, no duplicates
}

export type ImageRole = "front" | "back";
export interface ManifestImage { role: ImageRole; path: string; sha256: string }
export interface ImageManifestV1 {
  version: 1;
  images: ManifestImage[];  // canonical order: exactly one front, then optional back
  count: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isSafeInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const LOWER_SHA256 = /^[0-9a-f]{64}$/;
const ALLOWED_ROLES: ReadonlySet<string> = new Set(["front", "back"]);

export const isSha256Hex = (v: unknown): v is string => typeof v === "string" && LOWER_SHA256.test(v);

// Constant-time-ish equality for two same-length hex digests (avoids leaking a
// mismatch position via early return). Different lengths → not equal.
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A stored image storage path must be a plain, in-bucket relative path — never a
// traversal form, absolute path, backslash, protocol, whitespace, or NUL.
export function isSafeStoragePath(p: unknown): p is string {
  if (typeof p !== "string" || p.trim() !== p || p.length === 0) return false;
  if (p.startsWith("/") || p.startsWith("\\") || p.includes("//") || p.includes("\\")) return false;
  if (p.includes("..") || p.includes("\0")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return false; // no scheme (http:, file:, data:, …)
  return true;
}

const isSortedUniqueStrings = (a: unknown): a is string[] => {
  if (!Array.isArray(a)) return false;
  for (let i = 0; i < a.length; i++) {
    if (!nonEmptyStr(a[i])) return false;
    if (i > 0 && !(a[i - 1] < a[i])) return false; // strictly increasing → sorted AND unique
  }
  return true;
};

const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]): boolean => {
  const set = new Set(allowed);
  return Object.keys(o).every((k) => set.has(k));
};

// ── price / aspects / descriptors normalization (builder side) ──────────────
export function normalizePriceString(value: unknown): string | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toFixed(2);
}

export function canonicalAspects(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!isObj(raw)) return out;
  for (const key of Object.keys(raw)) {
    if (!nonEmptyStr(key)) continue;
    const v = raw[key];
    const values = Array.from(new Set((Array.isArray(v) ? v : [v]).filter(nonEmptyStr))).sort();
    if (values.length > 0) out[key] = values;
  }
  return out;
}

export function canonicalDescriptors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const acc = raw
    .map((d) => {
      if (nonEmptyStr(d)) return d;
      if (isObj(d)) {
        const name = typeof d.name === "string" ? d.name : "";
        const values = Array.isArray(d.values) ? d.values.filter(nonEmptyStr) : [];
        return name ? `${name}=${Array.from(new Set(values)).sort().join(",")}` : "";
      }
      return "";
    })
    .filter(nonEmptyStr);
  return Array.from(new Set(acc)).sort();
}

// ── builders (canonicalize TRUSTED handler input) ───────────────────────────
export interface IntendedStateInput {
  sku: string; marketplaceId: string; categoryId: string; merchantLocationKey: string;
  fulfillmentPolicyId: string; paymentPolicyId: string; returnPolicyId: string;
  price: number; currency: string; availableQuantity: number; listingDescription: string;
  title: string; description: string; condition: string; conditionDescription: string;
  conditionDescriptors?: unknown; aspects?: unknown;
}

export function buildIntendedState(input: IntendedStateInput): IntendedStateV1 | null {
  const price = normalizePriceString(input.price);
  if (price === null) return null;
  if (!isSafeInt(input.availableQuantity) || input.availableQuantity < 1 || input.availableQuantity > MAX_QUANTITY) return null;
  if (!SUPPORTED_CURRENCIES.has(input.currency)) return null;
  if (!nonEmptyStr(input.sku) || !nonEmptyStr(input.marketplaceId) || !nonEmptyStr(input.categoryId)) return null;
  if (!nonEmptyStr(input.merchantLocationKey) || !nonEmptyStr(input.fulfillmentPolicyId) || !nonEmptyStr(input.paymentPolicyId) || !nonEmptyStr(input.returnPolicyId)) return null;
  if (!nonEmptyStr(input.title) || input.title.length > EBAY_TITLE_MAX) return null;
  if (!nonEmptyStr(input.listingDescription) || !nonEmptyStr(input.description) || !nonEmptyStr(input.condition)) return null;
  return {
    version: 1, sku: input.sku, marketplaceId: input.marketplaceId, format: "FIXED_PRICE",
    categoryId: input.categoryId, merchantLocationKey: input.merchantLocationKey,
    fulfillmentPolicyId: input.fulfillmentPolicyId, paymentPolicyId: input.paymentPolicyId, returnPolicyId: input.returnPolicyId,
    price, currency: input.currency, availableQuantity: input.availableQuantity,
    listingDescription: input.listingDescription, title: input.title, description: input.description,
    condition: input.condition, conditionDescription: input.conditionDescription ?? "",
    conditionDescriptors: canonicalDescriptors(input.conditionDescriptors), aspects: canonicalAspects(input.aspects),
  };
}

export function buildImageManifest(images: Array<{ role: ImageRole; path: string; sha256: string }>): ImageManifestV1 | null {
  if (!Array.isArray(images) || images.length < 1 || images.length > 2) return null;
  const cleaned: ManifestImage[] = [];
  for (const img of images) {
    if (!img || (img.role !== "front" && img.role !== "back")) return null;
    if (!isSafeStoragePath(img.path) || !isSha256Hex(img.sha256)) return null;
    cleaned.push({ role: img.role, path: img.path, sha256: img.sha256 });
  }
  const manifest: ImageManifestV1 = { version: 1, images: cleaned, count: cleaned.length };
  // Validate the built manifest through the SAME strict rules the parser enforces
  // (exactly one front first, optional back second, unique roles/paths/hashes).
  return parseImageManifest(manifest);
}

// ── strict, exact-schema, canonical parsers (UNTRUSTED stored state) ─────────
const INTENDED_KEYS = ["version", "sku", "marketplaceId", "format", "categoryId", "merchantLocationKey", "fulfillmentPolicyId", "paymentPolicyId", "returnPolicyId", "price", "currency", "availableQuantity", "listingDescription", "title", "description", "condition", "conditionDescription", "conditionDescriptors", "aspects"] as const;

export function parseIntendedState(raw: unknown): IntendedStateV1 | null {
  if (!isObj(raw) || raw.version !== INTENDED_STATE_VERSION) return null;
  const s = raw as Record<string, unknown>;
  if (!onlyKeys(s, INTENDED_KEYS)) return null;                       // exact schema
  if (s.format !== "FIXED_PRICE") return null;
  for (const k of ["sku", "marketplaceId", "categoryId", "merchantLocationKey", "fulfillmentPolicyId", "paymentPolicyId", "returnPolicyId", "listingDescription", "title", "description", "condition"] as const) {
    if (!nonEmptyStr(s[k])) return null;
  }
  if ((s.title as string).length > EBAY_TITLE_MAX) return null;
  if (typeof s.conditionDescription !== "string") return null;       // optional but must be a string
  if (!nonEmptyStr(s.currency) || !SUPPORTED_CURRENCIES.has(s.currency as string)) return null;
  if (normalizePriceString(s.price) !== s.price) return null;        // canonical positive 2dp
  if (!isSafeInt(s.availableQuantity) || (s.availableQuantity as number) < 1 || (s.availableQuantity as number) > MAX_QUANTITY) return null;
  if (!isSortedUniqueStrings(s.conditionDescriptors)) return null;   // canonical: sorted, no dups
  if (!isObj(s.aspects)) return null;
  const aspects: Record<string, string[]> = {};
  for (const key of Object.keys(s.aspects)) {
    if (!nonEmptyStr(key)) return null;
    if (!isSortedUniqueStrings((s.aspects as Record<string, unknown>)[key])) return null; // sorted, no dup values
    aspects[key] = ((s.aspects as Record<string, unknown>)[key] as string[]).slice();
  }
  return {
    version: 1, sku: s.sku as string, marketplaceId: s.marketplaceId as string, format: "FIXED_PRICE",
    categoryId: s.categoryId as string, merchantLocationKey: s.merchantLocationKey as string,
    fulfillmentPolicyId: s.fulfillmentPolicyId as string, paymentPolicyId: s.paymentPolicyId as string, returnPolicyId: s.returnPolicyId as string,
    price: s.price as string, currency: s.currency as string, availableQuantity: s.availableQuantity as number,
    listingDescription: s.listingDescription as string, title: s.title as string, description: s.description as string,
    condition: s.condition as string, conditionDescription: s.conditionDescription as string,
    conditionDescriptors: (s.conditionDescriptors as string[]).slice(), aspects,
  };
}

export function parseImageManifest(raw: unknown): ImageManifestV1 | null {
  if (!isObj(raw) || raw.version !== IMAGE_MANIFEST_VERSION) return null;
  const m = raw as Record<string, unknown>;
  if (!onlyKeys(m, ["version", "images", "count"])) return null;     // exact schema
  if (!Array.isArray(m.images) || m.images.length < 1 || m.images.length > 2) return null;
  if (!isSafeInt(m.count) || m.count !== m.images.length) return null;
  const images: ManifestImage[] = [];
  const paths = new Set<string>(), hashes = new Set<string>(), roles = new Set<string>();
  for (let i = 0; i < m.images.length; i++) {
    const img = m.images[i];
    if (!isObj(img) || !onlyKeys(img, ["role", "path", "sha256"])) return null;
    if (typeof img.role !== "string" || !ALLOWED_ROLES.has(img.role)) return null;
    if (!isSafeStoragePath(img.path) || !isSha256Hex(img.sha256)) return null;
    // Canonical order proven, never silently reordered: index 0 = front, 1 = back.
    if (i === 0 && img.role !== "front") return null;
    if (i === 1 && img.role !== "back") return null;
    if (roles.has(img.role) || paths.has(img.path) || hashes.has(img.sha256)) return null; // unique role/path/hash
    roles.add(img.role); paths.add(img.path); hashes.add(img.sha256);
    images.push({ role: img.role as ImageRole, path: img.path, sha256: img.sha256 });
  }
  return { version: 1, images, count: images.length };
}

// ── canonical serialization + SHA-256 fingerprint ───────────────────────────
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

export function canonicalListingFingerprint(state: IntendedStateV1, manifest: ImageManifestV1): Promise<string> {
  const payload = `v${LISTING_FINGERPRINT_VERSION}|state:${stableStringify(state)}|images:${stableStringify(manifest)}`;
  return sha256Hex(payload);
}

// ── durable-snapshot verifier: RECOMPUTE, never trust a stored fingerprint ───
export type SnapshotVerifyOutcome =
  | "valid" | "missing_intended_state" | "invalid_intended_state"
  | "unsupported_fingerprint_version" | "invalid_fingerprint_format" | "fingerprint_mismatch";

export interface StoredSnapshotRow {
  intendedState: unknown;
  imageManifest: unknown;
  fingerprint: unknown;
  fingerprintVersion: unknown;
}

export type SnapshotVerifyResult =
  | { outcome: "valid"; intended: IntendedStateV1; manifest: ImageManifestV1; fingerprint: string }
  | { outcome: Exclude<SnapshotVerifyOutcome, "valid"> };

/**
 * Verify a stored durable listing-intent snapshot by RECOMPUTING its fingerprint.
 * A stored fingerprint is NEVER trusted merely because it is present: the intended
 * state + image manifest are re-parsed strictly, the fingerprint version + format
 * are checked, and canonicalListingFingerprint is recomputed and compared with a
 * timing-safe comparison. Any altered field fails closed BEFORE the snapshot is
 * used for any provider read or mutation.
 */
export async function verifyDurableIntendedSnapshot(row: StoredSnapshotRow): Promise<SnapshotVerifyResult> {
  if (row.intendedState == null || row.imageManifest == null) return { outcome: "missing_intended_state" };
  const intended = parseIntendedState(row.intendedState);
  const manifest = parseImageManifest(row.imageManifest);
  if (!intended || !manifest) return { outcome: "invalid_intended_state" };
  if (row.fingerprintVersion !== LISTING_FINGERPRINT_VERSION) return { outcome: "unsupported_fingerprint_version" };
  if (!isSha256Hex(row.fingerprint)) return { outcome: "invalid_fingerprint_format" };
  const recomputed = await canonicalListingFingerprint(intended, manifest);
  if (!timingSafeEqualHex(recomputed, row.fingerprint as string)) return { outcome: "fingerprint_mismatch" };
  return { outcome: "valid", intended, manifest, fingerprint: row.fingerprint as string };
}
