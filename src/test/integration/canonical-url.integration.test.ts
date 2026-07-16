/**
 * The pricecharting_products BEFORE trigger persists the canonical /game/ URL at
 * catalog-write time (mirroring buildGameUrl), so the page adapter consumes a
 * stored url instead of re-deriving a slug per request. Env-gated like the others.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("pricecharting canonical_url persistence", () => {
  let admin: SupabaseClient;
  const stamp = `${Math.floor(performance.now())}`;

  beforeAll(() => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: "canon-service" } });
  });

  it("auto-populates canonical_url on insert, matching the buildGameUrl slug", async () => {
    const product_id = `T${stamp}`;
    const { error: insErr } = await admin.from("pricecharting_products").insert({
      product_id,
      product_name: "Rayquaza VMAX #47",
      console_name: "Pokemon Japanese Blue Sky Stream",
      raw_response: {},
    } as never);
    expect(insErr).toBeNull();

    const { data, error } = await admin.from("pricecharting_products").select("canonical_url").eq("product_id", product_id).single();
    expect(error).toBeNull();
    expect((data as { canonical_url: string }).canonical_url).toBe(
      "https://www.pricecharting.com/game/pokemon-japanese-blue-sky-stream/rayquaza-vmax-47",
    );

    await admin.from("pricecharting_products").delete().eq("product_id", product_id);
  });

  it("never overwrites an explicitly-provided canonical_url", async () => {
    const product_id = `T${stamp}b`;
    const explicit = "https://www.pricecharting.com/game/pokemon-base-set/charizard-4";
    await admin.from("pricecharting_products").insert({
      product_id, product_name: "Charizard #4", console_name: "Pokemon Base Set", raw_response: {}, canonical_url: explicit,
    } as never);
    const { data } = await admin.from("pricecharting_products").select("canonical_url").eq("product_id", product_id).single();
    expect((data as { canonical_url: string }).canonical_url).toBe(explicit);
    await admin.from("pricecharting_products").delete().eq("product_id", product_id);
  });
});
