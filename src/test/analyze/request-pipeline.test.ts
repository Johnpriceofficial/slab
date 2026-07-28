import { describe, expect, it, vi } from "vitest";
import {
  runAnalyzeRequestPipeline,
  type AnalyzePipelineDeps,
} from "../../server/analyze-slab/request-pipeline";
import { DEFAULT_IMAGE_LIMITS } from "../../server/analyze-slab/validate-images";

/**
 * Locks the exact request-processing order for analyze-slab (steps 4–8) and
 * proves the security invariants that motivated the pre-production refactor:
 * validation is never hidden behind the provider-configuration check, and a
 * rejected payload never consumes quota or calls the provider.
 */

function jpegB64(totalBytes = 24): string {
  const bytes = new Uint8Array(totalBytes);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return Buffer.from(bytes).toString("base64");
}

const GOOD_BODY = { front_image_base64: jpegB64(), front_mime: "image/jpeg" };

function deps(overrides: Partial<AnalyzePipelineDeps> = {}): {
  deps: AnalyzePipelineDeps;
  consumeQuota: ReturnType<typeof vi.fn>;
  runAnalysis: ReturnType<typeof vi.fn>;
  getApiKey: ReturnType<typeof vi.fn>;
} {
  const consumeQuota = vi.fn(async () => true);
  const runAnalysis = vi.fn(async () => ({ statusCode: 200, body: { status: "success" } }));
  const getApiKey = vi.fn(() => "sk-present");
  const base: AnalyzePipelineDeps = {
    role: "customer",
    parseJson: async () => ({ ok: true, value: GOOD_BODY }),
    consumeQuota,
    getApiKey,
    runAnalysis,
    ...overrides,
  };
  return { deps: base, consumeQuota, runAnalysis, getApiKey };
}

describe("analyze-slab request pipeline ordering", () => {
  it("malformed JSON → 400 INVALID_PARAMETER even when the provider key is absent; no quota, no provider", async () => {
    const { deps: d, consumeQuota, runAnalysis } = deps({
      parseJson: async () => ({ ok: false }),
      getApiKey: () => undefined,
    });
    const res = await runAnalyzeRequestPipeline(d);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error_code: "INVALID_PARAMETER" });
    expect(consumeQuota).not.toHaveBeenCalled();
    expect(runAnalysis).not.toHaveBeenCalled();
  });

  it("malformed image → typed 400/413 even when the provider key is absent; no quota, no provider", async () => {
    const cases: Array<[unknown, string, number]> = [
      [{ front_image_base64: "!!!", front_mime: "image/jpeg" }, "INVALID_BASE64", 400],
      [{ front_image_base64: jpegB64(), front_mime: "image/gif" }, "UNSUPPORTED_IMAGE", 400],
      [{ front_mime: "image/jpeg" }, "MISSING_IMAGE", 400],
      [{ front_image_base64: jpegB64(), front_mime: "image/jpeg", variants: "x" }, "INVALID_PARAMETER", 400],
    ];
    for (const [value, code, status] of cases) {
      const { deps: d, consumeQuota, runAnalysis } = deps({
        parseJson: async () => ({ ok: true, value }),
        getApiKey: () => undefined,
      });
      const res = await runAnalyzeRequestPipeline(d);
      expect(res.statusCode, code).toBe(status);
      expect(res.body).toMatchObject({ error_code: code });
      expect(consumeQuota).not.toHaveBeenCalled();
      expect(runAnalysis).not.toHaveBeenCalled();
    }

    const { deps: big, consumeQuota, runAnalysis } = deps({
      parseJson: async () => ({ ok: true, value: { front_image_base64: jpegB64(64), front_mime: "image/jpeg" } }),
      imageLimits: { ...DEFAULT_IMAGE_LIMITS, maxImageBytes: 16 },
      getApiKey: () => undefined,
    });
    const res = await runAnalyzeRequestPipeline(big);
    expect(res.statusCode).toBe(413);
    expect(res.body).toMatchObject({ error_code: "IMAGE_TOO_LARGE" });
    expect(consumeQuota).not.toHaveBeenCalled();
    expect(runAnalysis).not.toHaveBeenCalled();
  });

  it("quota exhaustion → 429 without reaching the provider-config check or provider", async () => {
    const { deps: d, getApiKey, runAnalysis } = deps({ consumeQuota: vi.fn(async () => false) });
    const res = await runAnalyzeRequestPipeline(d);
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ error_code: "QUOTA_EXCEEDED" });
    // Quota is checked (6) BEFORE the provider-config check (7).
    expect(getApiKey).not.toHaveBeenCalled();
    expect(runAnalysis).not.toHaveBeenCalled();
  });

  it("NOT_CONFIGURED is reached only after validation and quota both pass", async () => {
    const { deps: d, consumeQuota, runAnalysis } = deps({ getApiKey: () => undefined });
    const res = await runAnalyzeRequestPipeline(d);
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ error_code: "NOT_CONFIGURED" });
    // A well-formed request DID pass validation and consume quota before the
    // provider-config check — the specified order (quota=6, provider=7).
    expect(consumeQuota).toHaveBeenCalledTimes(1);
    expect(runAnalysis).not.toHaveBeenCalled();
  });

  it("valid request with a configured provider reaches step 8 exactly once", async () => {
    const { deps: d, consumeQuota, runAnalysis } = deps();
    const res = await runAnalyzeRequestPipeline(d);
    expect(res.statusCode).toBe(200);
    expect(consumeQuota).toHaveBeenCalledTimes(1);
    expect(runAnalysis).toHaveBeenCalledTimes(1);
    expect(runAnalysis).toHaveBeenCalledWith(GOOD_BODY, "sk-present");
  });

  it("routes the quota role correctly and preserves admin vs customer messages", async () => {
    const adminQuota = vi.fn(async () => false);
    const admin = deps({ role: "admin", consumeQuota: adminQuota });
    const adminRes = await runAnalyzeRequestPipeline(admin.deps);
    expect(adminQuota).toHaveBeenCalledWith("admin");
    expect(adminRes.body).toMatchObject({ message: expect.stringContaining("image-analysis limit") });

    const custQuota = vi.fn(async () => false);
    const cust = deps({ role: "customer", consumeQuota: custQuota });
    const custRes = await runAnalyzeRequestPipeline(cust.deps);
    expect(custQuota).toHaveBeenCalledWith("customer");
    expect(custRes.body).toMatchObject({ message: expect.stringContaining("limit reached for this account") });
  });
});
