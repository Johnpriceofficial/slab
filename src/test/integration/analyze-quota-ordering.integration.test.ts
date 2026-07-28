/**
 * LIVE integration test for the analyze-slab provider-before-quota ordering.
 *
 * Drives the SAME shared request pipeline the Edge Function runs
 * (runAnalyzeRequestPipeline) with `consumeQuota` wired to the real
 * public.consume_user_daily_quota RPC on the disposable stack, and proves that
 * a valid request which hits NOT_CONFIGURED (no provider key) leaves the
 * customer's per-user quota row untouched — quota is consumed only once the
 * provider is confirmed configured.
 *
 * Same env gating as every other integration suite: runs only against the
 * disposable test stack (SLABVAULT_TEST_*), never production.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runAnalyzeRequestPipeline } from "../../server/analyze-slab/request-pipeline";

const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ??
  {}) as Record<string, string | undefined>;

const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

function jpegB64(totalBytes = 24): string {
  const bytes = new Uint8Array(totalBytes);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return Buffer.from(bytes).toString("base64");
}

suite("analyze-slab provider-before-quota ordering (per-user quota)", () => {
  let service: SupabaseClient;
  const stamp = `${Math.floor(performance.now())}`;
  const bucket = `analyze-quota-order-${stamp}`;
  const userIds: string[] = [];
  let userId = "";

  async function usageCount(uid: string): Promise<number> {
    const { data } = await service
      .from("api_user_daily_usage")
      .select("count")
      .eq("user_id", uid)
      .eq("bucket", bucket)
      .maybeSingle();
    return (data as { count?: number } | null)?.count ?? 0;
  }

  // Mirrors the Edge Function's per-user quota consumption for this bucket.
  const consumeQuota = async (): Promise<boolean> => {
    const { data, error } = await service.rpc("consume_user_daily_quota", {
      p_user_id: userId,
      p_bucket: bucket,
      p_hard_limit: 25,
    });
    return !error && data === true;
  };

  const validBody = { front_image_base64: jpegB64(), front_mime: "image/jpeg" };

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: `quota-order-${stamp}` },
    });
    const { data, error } = await service.auth.admin.createUser({
      email: `quota-order-${stamp}@slabvault.test`,
      password: `Test-qo-${stamp}`,
      email_confirm: true,
    });
    if (error) throw error;
    userId = data.user!.id;
    userIds.push(userId);
    // Let the profile trigger provision an active customer_profiles row.
    await new Promise((r) => setTimeout(r, 400));
  }, 30_000);

  afterAll(async () => {
    // Deletes the user and cascades its customer_profiles + quota rows; the
    // account owns no slabs/cards, so no RESTRICT FK blocks it.
    for (const id of userIds) await service.auth.admin.deleteUser(id).catch(() => {});
  });

  it("a valid request with no provider key returns NOT_CONFIGURED and consumes NO quota", async () => {
    const before = await usageCount(userId);
    expect(before).toBe(0);

    let providerCalled = false;
    const result = await runAnalyzeRequestPipeline({
      role: "customer",
      parseJson: async () => ({ ok: true, value: validBody }),
      consumeQuota,
      getApiKey: () => undefined, // provider not configured
      runAnalysis: async () => {
        providerCalled = true;
        return { statusCode: 200, body: { status: "success" } };
      },
    });

    expect(result.statusCode).toBe(502);
    expect(result.body).toMatchObject({ error_code: "NOT_CONFIGURED" });
    expect(providerCalled).toBe(false);
    // The real per-user quota row is unchanged: the provider-config check
    // short-circuited before consume_user_daily_quota was ever called.
    expect(await usageCount(userId)).toBe(0);
  });

  it("positive control: with a provider key present, the same request consumes exactly one unit", async () => {
    const before = await usageCount(userId);
    const result = await runAnalyzeRequestPipeline({
      role: "customer",
      parseJson: async () => ({ ok: true, value: validBody }),
      consumeQuota,
      getApiKey: () => "sk-present",
      runAnalysis: async (_input, apiKey) => ({
        statusCode: 200,
        body: { status: "success", apiKey },
      }),
    });
    expect(result.statusCode).toBe(200);
    expect(await usageCount(userId)).toBe(before + 1);
  });
});
