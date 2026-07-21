import { describe, it, expect } from "vitest";
import {
  parseSignatureHeader,
  publicKeyToDer,
  derEcdsaToP1363,
  hashName,
  createPublicKeyCache,
  verifyEbayNotificationSignature,
  processEbayNotification,
  type EbayPublicKey,
} from "../../../supabase/functions/_shared/ebay-notification-verify";

// ── helpers ────────────────────────────────────────────────────────────────
function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function encodeSignatureHeader(obj: Record<string, unknown>): string {
  return btoa(JSON.stringify(obj));
}
function toPem(spki: ArrayBuffer): string {
  const b64 = bytesToBase64(new Uint8Array(spki));
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
}
// Web Crypto's ECDSA sign emits raw r‖s (P1363); eBay sends DER. Re-encode so
// the fixture matches eBay's wire format and exercises derEcdsaToP1363.
function toDerInteger(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  let b = bytes.slice(i);
  if (b[0] & 0x80) b = Uint8Array.of(0x00, ...b);
  return Uint8Array.of(0x02, b.length, ...b);
}
function p1363ToDer(raw: Uint8Array): Uint8Array {
  const n = raw.length / 2;
  const r = toDerInteger(raw.slice(0, n));
  const s = toDerInteger(raw.slice(n));
  const body = new Uint8Array([...r, ...s]);
  return new Uint8Array([0x30, body.length, ...body]);
}

async function signedFixture(body: string, hash: "SHA-256" | "SHA-1") {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const rawSig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: { name: hash } }, pair.privateKey, new TextEncoder().encode(body)),
  );
  const derSig = p1363ToDer(rawSig);
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  const header = encodeSignatureHeader({
    kid: "key-123",
    signature: bytesToBase64(derSig),
    digest: hash === "SHA-256" ? "SHA256" : "SHA1",
  });
  const publicKey: EbayPublicKey = { algorithm: "ECDSA", digest: hash === "SHA-256" ? "SHA256" : "SHA1", key: toPem(spki) };
  return { header, getPublicKey: async () => publicKey, publicKey };
}

// ── pure helpers ───────────────────────────────────────────────────────────
describe("parseSignatureHeader", () => {
  it("decodes a well-formed base64 JSON header", () => {
    const raw = encodeSignatureHeader({ kid: "abc", signature: "sig==", alg: "ecdsa", digest: "SHA1" });
    expect(parseSignatureHeader(raw)).toEqual({ kid: "abc", signature: "sig==", alg: "ecdsa", digest: "SHA1" });
  });
  it("returns null for null / empty / non-string", () => {
    expect(parseSignatureHeader(null)).toBeNull();
    expect(parseSignatureHeader("")).toBeNull();
    expect(parseSignatureHeader(undefined)).toBeNull();
  });
  it("returns null for undecodable or non-JSON content", () => {
    expect(parseSignatureHeader("%%%not base64%%%")).toBeNull();
    expect(parseSignatureHeader(btoa("not json"))).toBeNull();
  });
  it("returns null when kid or signature is missing", () => {
    expect(parseSignatureHeader(encodeSignatureHeader({ kid: "abc" }))).toBeNull();
    expect(parseSignatureHeader(encodeSignatureHeader({ signature: "s" }))).toBeNull();
  });
});

describe("hashName", () => {
  it("defaults to SHA-1 (eBay's documented notification digest)", () => {
    expect(hashName(undefined)).toBe("SHA-1");
    expect(hashName("SHA1")).toBe("SHA-1");
  });
  it("maps SHA256 variants", () => {
    expect(hashName("SHA256")).toBe("SHA-256");
    expect(hashName("SHA-256")).toBe("SHA-256");
  });
});

describe("publicKeyToDer", () => {
  it("strips PEM armor and whitespace before decoding", () => {
    const der = new Uint8Array([1, 2, 3, 4]);
    const pem = `-----BEGIN PUBLIC KEY-----\n${bytesToBase64(der)}\n-----END PUBLIC KEY-----`;
    expect(Array.from(publicKeyToDer(pem))).toEqual([1, 2, 3, 4]);
    expect(Array.from(publicKeyToDer(bytesToBase64(der)))).toEqual([1, 2, 3, 4]);
  });
});

describe("derEcdsaToP1363", () => {
  it("expands a DER signature to fixed-length r‖s and left-pads short integers", () => {
    // SEQUENCE { INTEGER 0x01, INTEGER 0x02 } -> 32-byte r (…01) ‖ 32-byte s (…02)
    const der = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]);
    const out = derEcdsaToP1363(der, 32);
    expect(out.length).toBe(64);
    expect(out[31]).toBe(0x01);
    expect(out[63]).toBe(0x02);
    expect(out[0]).toBe(0x00);
  });
  it("drops the DER sign byte on high-bit integers", () => {
    // INTEGER 0x00FF (sign byte) must become a single 0xFF in the last position
    const der = new Uint8Array([0x30, 0x08, 0x02, 0x02, 0x00, 0xff, 0x02, 0x02, 0x00, 0x80]);
    const out = derEcdsaToP1363(der, 32);
    expect(out[31]).toBe(0xff);
    expect(out[63]).toBe(0x80);
  });
  it("throws on malformed DER (fail closed upstream)", () => {
    expect(() => derEcdsaToP1363(new Uint8Array([0x31, 0x00]), 32)).toThrow();
  });
});

describe("createPublicKeyCache", () => {
  it("caches within the TTL and refetches after it expires", async () => {
    let now = 0;
    let calls = 0;
    const cache = createPublicKeyCache({ ttlMs: 1000, clock: () => now });
    const fetcher = async (): Promise<EbayPublicKey> => {
      calls++;
      return { algorithm: "ECDSA", key: "k" };
    };
    await cache.get("kid", fetcher);
    await cache.get("kid", fetcher);
    expect(calls).toBe(1); // cached
    now = 1500; // past TTL
    await cache.get("kid", fetcher);
    expect(calls).toBe(2);
    expect(cache.size()).toBe(1);
  });
});

// ── full round-trip verification ─────────────────────────────────────────────
describe("verifyEbayNotificationSignature", () => {
  it("verifies a correctly signed notification (ECDSA/SHA-256, DER over raw body)", async () => {
    const body = JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { notificationId: "n1" } });
    const fx = await signedFixture(body, "SHA-256");
    const res = await verifyEbayNotificationSignature({ rawBody: body, signatureHeader: fx.header, getPublicKey: fx.getPublicKey });
    expect(res).toEqual({ ok: true, reason: "verified", kid: "key-123" });
  });

  it("verifies eBay's documented ECDSA/SHA-1 default", async () => {
    const body = "sha1-signed-body";
    const fx = await signedFixture(body, "SHA-1");
    const res = await verifyEbayNotificationSignature({ rawBody: body, signatureHeader: fx.header, getPublicKey: fx.getPublicKey });
    expect(res.ok).toBe(true);
  });

  it("rejects a tampered body (signature_mismatch)", async () => {
    const body = "original-body";
    const fx = await signedFixture(body, "SHA-256");
    const res = await verifyEbayNotificationSignature({ rawBody: body + "X", signatureHeader: fx.header, getPublicKey: fx.getPublicKey });
    expect(res).toEqual({ ok: false, reason: "signature_mismatch", kid: "key-123" });
  });

  it("fails closed when the signature header is missing", async () => {
    const res = await verifyEbayNotificationSignature({ rawBody: "b", signatureHeader: null, getPublicKey: async () => ({ algorithm: "ECDSA", key: "" }) });
    expect(res).toEqual({ ok: false, reason: "missing_signature_header" });
  });

  it("fails closed on a malformed header", async () => {
    const res = await verifyEbayNotificationSignature({ rawBody: "b", signatureHeader: "@@@", getPublicKey: async () => ({ algorithm: "ECDSA", key: "" }) });
    expect(res).toEqual({ ok: false, reason: "malformed_signature_header" });
  });

  it("fails closed when the public key cannot be retrieved", async () => {
    const fx = await signedFixture("b", "SHA-256");
    const res = await verifyEbayNotificationSignature({
      rawBody: "b",
      signatureHeader: fx.header,
      getPublicKey: async () => { throw new Error("network"); },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("public_key_unavailable");
  });

  it("fails closed on a non-ECDSA (unsupported) algorithm", async () => {
    const fx = await signedFixture("b", "SHA-256");
    const res = await verifyEbayNotificationSignature({
      rawBody: "b",
      signatureHeader: fx.header,
      getPublicKey: async () => ({ algorithm: "RSA", key: fx.publicKey.key }),
    });
    expect(res).toEqual({ ok: false, reason: "unsupported_algorithm", kid: "key-123" });
  });
});

// ── inbox persistence contract (P1 finding A1) ───────────────────────────────
describe("processEbayNotification — durable inbox before acknowledgement", () => {
  const body = JSON.stringify({ metadata: { topic: "ITEM_SOLD" }, notification: { notificationId: "evt-1" } });

  it("acknowledges (200) only after a successful persist, and stores the event", async () => {
    const fx = await signedFixture(body, "SHA-256");
    const writes: Array<{ notification_id: string; topic: string }> = [];
    const decision = await processEbayNotification({
      rawBody: body,
      signatureHeader: fx.header,
      getPublicKey: fx.getPublicKey,
      persist: async (r) => { writes.push(r); return { error: null }; },
    });
    expect(decision.status).toBe(200);
    expect(decision.persisted).toBe(true);
    expect(decision.body).toMatchObject({ status: "success", notification_id: "evt-1" });
    expect(writes).toEqual([{ notification_id: "evt-1", topic: "ITEM_SOLD", payload_sha256: expect.any(String) }]);
  });

  it("treats an ignored duplicate (persist resolves with no error) as 200 — replay safe", async () => {
    const fx = await signedFixture(body, "SHA-256");
    // upsert w/ ignoreDuplicates resolves { error: null } for an already-stored id.
    const decision = await processEbayNotification({
      rawBody: body, signatureHeader: fx.header, getPublicKey: fx.getPublicKey,
      persist: async () => ({ error: null }),
    });
    expect(decision.status).toBe(200);
    expect(decision.persisted).toBe(true);
  });

  it("returns a retryable 503 (NOT a false 200) when persistence resolves with { error }", async () => {
    const fx = await signedFixture(body, "SHA-256");
    const decision = await processEbayNotification({
      rawBody: body, signatureHeader: fx.header, getPublicKey: fx.getPublicKey,
      persist: async () => ({ error: { code: "57014", message: "canceling statement due to statement timeout" } }),
    });
    expect(decision.status).toBe(503);
    expect(decision.persisted).toBe(false);
    expect(decision.body.error_code).toBe("INBOX_PERSIST_FAILED");
    // No raw body / PII / secret in the response — only the event id.
    expect(JSON.stringify(decision.body)).not.toContain("statement timeout");
    expect(JSON.stringify(decision.body)).not.toContain("ITEM_SOLD");
  });

  it("rejects an invalid signature with 412 and NEVER calls persist", async () => {
    let calls = 0;
    const decision = await processEbayNotification({
      rawBody: body, signatureHeader: "@@@malformed@@@",
      getPublicKey: async () => ({ algorithm: "ECDSA", key: "" }),
      persist: async () => { calls++; return { error: null }; },
    });
    expect(decision.status).toBe(412);
    expect(decision.persisted).toBe(false);
    expect(calls).toBe(0);
  });

  it("rejects a tampered body with 412 and NEVER calls persist", async () => {
    const fx = await signedFixture(body, "SHA-256");
    let calls = 0;
    const decision = await processEbayNotification({
      rawBody: body + "TAMPERED", signatureHeader: fx.header, getPublicKey: fx.getPublicKey,
      persist: async () => { calls++; return { error: null }; },
    });
    expect(decision.status).toBe(412);
    expect(calls).toBe(0);
  });
});
