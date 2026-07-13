import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeSourceCrop, outputSize } from "@/lib/cards/scanner";
import {
  AUTO_ACCEPT_CONFIDENCE,
  classifyCardScan,
  isCardScanExtraction,
  normalizeCardNumber,
} from "../../../supabase/functions/_shared/card-scan-core";

describe("live card scanner", () => {
  it("maps the on-screen 5:7 guide into object-cover source pixels", () => {
    const crop = computeSourceCrop(
      1920, 1080,
      { left: 0, top: 0, width: 390, height: 700 },
      { left: 95, top: 70, width: 200, height: 560 },
    );
    expect(crop.sx).toBeGreaterThanOrEqual(0);
    expect(crop.sy).toBeGreaterThanOrEqual(0);
    expect(crop.sx + crop.sw).toBeLessThanOrEqual(1920);
    expect(crop.sy + crop.sh).toBeLessThanOrEqual(1080);
    expect(crop.sh / crop.sw).toBeCloseTo(2.8, 1);
  });

  it("caps the transmitted JPEG without stretching its aspect ratio", () => {
    const size = outputSize({ sx: 0, sy: 0, sw: 1000, sh: 2800 }, 1800);
    expect(size).toEqual({ width: 643, height: 1800 });
  });

  it("gates low-confidence results and duplicates before insertion", () => {
    expect(AUTO_ACCEPT_CONFIDENCE).toBe(0.75);
    expect(classifyCardScan(0.74, 0)).toBe("needs_review");
    expect(classifyCardScan(0.75, 1)).toBe("possible_duplicate");
    expect(classifyCardScan(0.91, 0)).toBe("auto_add");
  });

  it("requires the strict extracted shape", () => {
    expect(isCardScanExtraction({
      card_name: "Pikachu",
      set_name: "Base Set",
      card_number: "58/102",
      rarity: "Common",
      confidence: 0.9,
      condition_issues: { whitening: "", scratches: "", centering_notes: "Slightly left", other: "" },
    })).toBe(true);
    expect(isCardScanExtraction({ card_name: "Pikachu", confidence: 0.9 })).toBe(false);
    expect(normalizeCardNumber(" 058 / 102 ")).toBe("058/102");
  });

  it("keeps the OpenAI key server-only and creates a private review schema", () => {
    const migration = readFileSync("supabase/migrations/20260801000000_live_card_scanner.sql", "utf8");
    const edge = readFileSync("supabase/functions/scan-card/index.ts", "utf8");
    expect(migration).toContain("create table public.cards");
    expect(migration).toContain("create table public.card_scan_reviews");
    expect(migration).toContain("'card-scans', 'card-scans', false");
    expect(migration).toContain("enable row level security");
    expect(edge).toContain('Deno.env.get("OPENAI_API_KEY")');
    expect(edge).toContain('detail: "original"');
    expect(edge).toContain("store: false");
    expect(edge).not.toContain("VITE_OPENAI");
  });

  it("exposes authenticated inventory actions without browser writes", () => {
    const edge = readFileSync("supabase/functions/scan-card/index.ts", "utf8");
    const app = readFileSync("src/App.tsx", "utf8");
    for (const action of ["list_cards", "get_card", "update_card", "archive_card", "restore_card", "card_summary"]) {
      expect(edge).toContain(`action === "${action}"`);
    }
    expect(app).toContain('path="/cards"');
    expect(app).toContain('path="/cards/:id"');
  });

  it("isolates duplicate checks and quota consumption by authenticated owner", () => {
    const edge = readFileSync("supabase/functions/scan-card/index.ts", "utf8");
    const quota = readFileSync("supabase/functions/_shared/quota.ts", "utf8");
    expect(edge).toContain('.eq("created_by", userId)');
    expect(edge).toContain("consumeUserDailyQuota(userId");
    expect(edge).toContain("getCallerUser(req)");
    expect(edge).toContain("user.email_confirmed_at");
    expect(edge).not.toContain("isCallerAdmin(req)");
    expect(quota).toContain('admin.rpc("consume_user_daily_quota"');
  });

  it("defines public customer profiles, owner-only reads, and service-only quota RPC", () => {
    const migration = readFileSync("supabase/migrations/20260802000000_public_customer_accounts.sql", "utf8");
    expect(migration).toContain("create table public.customer_profiles");
    expect(migration).toContain("create table public.api_user_daily_usage");
    expect(migration).toContain("created_by = (select auth.uid())");
    expect(migration).toContain('and (storage.foldername(name))[1] = (select auth.uid())::text');
    expect(migration).toContain("revoke all on function public.consume_user_daily_quota(uuid, text, integer) from public, anon, authenticated");
    expect(migration).toContain("grant execute on function public.consume_user_daily_quota(uuid, text, integer) to service_role");
  });
});
