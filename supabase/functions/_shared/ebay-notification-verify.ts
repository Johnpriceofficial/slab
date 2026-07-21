// eBay Event Notification signature verification — pure, cross-runtime.
//
// This module contains ONLY the cryptographic verification of an inbound eBay
// notification. It imports nothing runtime-specific (no `Deno.env`, no `npm:`
// specifiers) and uses only Web Crypto, so the SAME code runs inside the Deno
// Edge Function AND is unit-tested under vitest (see
// src/test/ebay/notification-verify.test.ts), matching the `card-scan-core`
// pattern already used in this repo.
//
// How eBay signs a notification (Notification API):
//   * Every push carries an `x-ebay-signature` request header that is a
//     base64-encoded JSON object: { "kid": <publicKeyId>, "signature": <base64
//     DER-ECDSA signature>, "alg"/"digest": <hash hint> }.
//   * The signature is computed by eBay over the EXACT raw request body bytes.
//   * The verifier fetches the matching public key from
//     GET /commerce/notification/v1/public_key/{kid} (an X.509 SubjectPublicKeyInfo
//     key, PEM or base64 DER), caches it (~1 hour), and verifies the ECDSA
//     signature over the raw body.
//
// Everything fails closed: any missing/malformed header, unavailable key,
// unsupported algorithm, or verification error returns `{ ok: false }` with a
// typed reason. The exact on-the-wire bytes eBay emits are confirmed against a
// live sandbox notification (Phase 14 gate); the crypto pipeline itself is
// proven by the round-trip unit tests.

/** Decoded contents of the base64 `x-ebay-signature` header. */
export interface EbaySignatureHeader {
  kid: string;
  signature: string; // base64, DER-encoded ECDSA signature
  alg?: string; // e.g. "ecdsa"
  digest?: string; // e.g. "SHA1" | "SHA256"
}

/** Shape of the eBay getPublicKey response used for verification. */
export interface EbayPublicKey {
  algorithm: string; // e.g. "ECDSA"
  digest?: string; // e.g. "SHA1"
  key: string; // PEM ("-----BEGIN PUBLIC KEY-----") or bare base64 SPKI (DER)
}

export type VerifyReason =
  | "verified"
  | "missing_signature_header"
  | "malformed_signature_header"
  | "public_key_unavailable"
  | "unsupported_algorithm"
  | "signature_mismatch"
  | "verification_error";

export interface VerifyResult {
  ok: boolean;
  reason: VerifyReason;
  kid?: string;
}

const WEB_CRYPTO_HASHES: Record<string, string> = {
  SHA1: "SHA-1",
  "SHA-1": "SHA-1",
  SHA256: "SHA-256",
  "SHA-256": "SHA-256",
  SHA384: "SHA-384",
  "SHA-384": "SHA-384",
  SHA512: "SHA-512",
  "SHA-512": "SHA-512",
};

// Curve name -> the fixed component length (bytes) of a raw (P1363) r||s
// signature. eBay's notification keys are P-256; the others are supported so a
// future eBay change to a larger curve does not silently break verification.
const CURVE_COMPONENT_BYTES: Record<string, number> = {
  "P-256": 32,
  "P-384": 48,
  "P-521": 66,
};

/** eBay's default notification hash when the header/key omit an explicit one. */
export function hashName(digest: string | undefined): string {
  if (!digest) return "SHA-1";
  return WEB_CRYPTO_HASHES[digest.toUpperCase()] ?? "SHA-1";
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0));
}

// Web Crypto's TS types (DOM lib 5.7+) require an ArrayBuffer-backed view rather
// than a generic ArrayBufferLike one; copy into a fresh buffer at the boundary.
function toAb(bytes: Uint8Array) {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

/**
 * Parse the base64-encoded `x-ebay-signature` header into its fields. Returns
 * null (never throws) for any missing/undecodable/incomplete header so callers
 * fail closed.
 */
export function parseSignatureHeader(raw: string | null | undefined): EbaySignatureHeader | null {
  if (!raw || typeof raw !== "string") return null;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(base64ToBytes(raw.trim())));
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const kid = typeof obj.kid === "string" ? obj.kid : "";
  const signature = typeof obj.signature === "string" ? obj.signature : "";
  if (!kid || !signature) return null;
  return {
    kid,
    signature,
    alg: typeof obj.alg === "string" ? obj.alg : undefined,
    digest: typeof obj.digest === "string" ? obj.digest : undefined,
  };
}

/** Strip PEM armor (if present) and base64-decode to raw DER bytes. */
export function publicKeyToDer(key: string): Uint8Array {
  const body = key
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return base64ToBytes(body);
}

/**
 * Convert a DER-encoded ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }) into
 * the fixed-length raw r‖s (IEEE P1363) form Web Crypto's verify expects.
 * Throws on malformed DER so the caller maps it to a fail-closed reason.
 */
export function derEcdsaToP1363(der: Uint8Array, componentBytes: number): Uint8Array {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error("ECDSA DER: expected SEQUENCE");
  // Skip the SEQUENCE length (short or long form); we re-read each INTEGER.
  let seqLen = der[offset++];
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    for (let i = 0; i < n; i++) offset++;
  }
  const readInt = (): Uint8Array => {
    if (der[offset++] !== 0x02) throw new Error("ECDSA DER: expected INTEGER");
    const len = der[offset++];
    let bytes = der.slice(offset, offset + len);
    offset += len;
    // DER integers are big-endian and may carry a leading 0x00 sign byte.
    while (bytes.length > componentBytes && bytes[0] === 0x00) bytes = bytes.slice(1);
    if (bytes.length > componentBytes) throw new Error("ECDSA DER: component too large");
    if (bytes.length < componentBytes) {
      const padded = new Uint8Array(componentBytes);
      padded.set(bytes, componentBytes - bytes.length);
      bytes = padded;
    }
    return bytes;
  };
  const r = readInt();
  const s = readInt();
  const out = new Uint8Array(componentBytes * 2);
  out.set(r, 0);
  out.set(s, componentBytes);
  return out;
}

/**
 * Verify an ECDSA signature (as eBay sends it: base64 DER, over the raw body)
 * against a public key. Tries the candidate curves (P-256 first, eBay's actual
 * curve) because the SPKI does not expose the curve to Web Crypto's importKey
 * up front. Returns false (never throws) on any failure.
 */
export async function verifyEcdsaOverBody(args: {
  rawBody: string;
  signatureBase64: string;
  publicKey: string; // PEM or base64 SPKI
  hash: string; // Web Crypto hash name, e.g. "SHA-256"
  curves?: string[];
}): Promise<boolean> {
  const { rawBody, signatureBase64, publicKey, hash } = args;
  const curves = args.curves ?? ["P-256", "P-384", "P-521"];
  const spki = publicKeyToDer(publicKey);
  const derSig = base64ToBytes(signatureBase64);
  const data = new TextEncoder().encode(rawBody);
  for (const curve of curves) {
    const componentBytes = CURVE_COMPONENT_BYTES[curve];
    if (!componentBytes) continue;
    try {
      const key = await crypto.subtle.importKey(
        "spki",
        toAb(spki),
        { name: "ECDSA", namedCurve: curve },
        false,
        ["verify"],
      );
      const p1363 = derEcdsaToP1363(derSig, componentBytes);
      const ok = await crypto.subtle.verify({ name: "ECDSA", hash: { name: hash } }, key, toAb(p1363), toAb(data));
      if (ok) return true;
    } catch {
      // Wrong curve for this key, or malformed input for this curve — try next.
    }
  }
  return false;
}

/**
 * A tiny TTL cache for public keys keyed by `kid`. eBay recommends caching the
 * getPublicKey result for ~1 hour. The clock is injectable for tests.
 */
export function createPublicKeyCache(opts: { ttlMs?: number; clock?: () => number } = {}) {
  const ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
  const clock = opts.clock ?? (() => Date.now());
  const store = new Map<string, { value: EbayPublicKey; expires: number }>();
  return {
    async get(kid: string, fetcher: (kid: string) => Promise<EbayPublicKey>): Promise<EbayPublicKey> {
      const now = clock();
      const hit = store.get(kid);
      if (hit && hit.expires > now) return hit.value;
      const value = await fetcher(kid);
      store.set(kid, { value, expires: now + ttlMs });
      return value;
    },
    size(): number {
      return store.size;
    },
  };
}

/**
 * Full fail-closed verification of an inbound eBay notification's signature.
 * `getPublicKey` is injected (production wires it to the cached getPublicKey
 * call; tests supply a fixture), so this function has no I/O of its own.
 */
export async function verifyEbayNotificationSignature(args: {
  rawBody: string;
  signatureHeader: string | null | undefined;
  getPublicKey: (kid: string) => Promise<EbayPublicKey>;
}): Promise<VerifyResult> {
  const parsed = parseSignatureHeader(args.signatureHeader);
  if (!args.signatureHeader) return { ok: false, reason: "missing_signature_header" };
  if (!parsed) return { ok: false, reason: "malformed_signature_header" };

  let pub: EbayPublicKey;
  try {
    pub = await args.getPublicKey(parsed.kid);
  } catch {
    return { ok: false, reason: "public_key_unavailable", kid: parsed.kid };
  }
  if (!pub || typeof pub.key !== "string" || !pub.key) {
    return { ok: false, reason: "public_key_unavailable", kid: parsed.kid };
  }
  if (pub.algorithm && !/ecdsa/i.test(pub.algorithm)) {
    return { ok: false, reason: "unsupported_algorithm", kid: parsed.kid };
  }

  try {
    const ok = await verifyEcdsaOverBody({
      rawBody: args.rawBody,
      signatureBase64: parsed.signature,
      publicKey: pub.key,
      hash: hashName(parsed.digest ?? pub.digest),
    });
    return ok
      ? { ok: true, reason: "verified", kid: parsed.kid }
      : { ok: false, reason: "signature_mismatch", kid: parsed.kid };
  } catch {
    return { ok: false, reason: "verification_error", kid: parsed.kid };
  }
}
