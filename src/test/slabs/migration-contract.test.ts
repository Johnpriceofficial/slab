import { describe, expect, it } from "vitest";
import remoteOptionalBack from "../../../supabase/migrations/20260713002148_optional_back_image.sql?raw";
import repoOptionalBack from "../../../supabase/migrations/20260720000000_optional_back_image.sql?raw";
import confirmationSql from "../../../supabase/migrations/20260726000000_confirmation_rpc.sql?raw";
import consolidationSql from "../../../supabase/migrations/20260727000000_confidence_consolidation.sql?raw";

describe("migration contract", () => {
  it("reconciles the remote-only migration as the exact historical SQL", () => {
    expect(remoteOptionalBack).toBe(repoOptionalBack);
  });

  it("allows incomplete drafts but enforces complete verified rows and a front image", () => {
    expect(consolidationSql).toContain("alter column card_name drop not null");
    expect(consolidationSql).toContain("verification_status <> 'verified' or (card_name is not null");
    expect(consolidationSql).toContain("verification_status <> 'verified' or (grader is not null");
    expect(consolidationSql).toContain("verification_status <> 'verified' or (grade is not null");
    expect(consolidationSql).toContain("verification_status <> 'verified' or\n      (certification_number is not null");
    expect(consolidationSql).toContain("slabs_front_image_required");
  });

  it("persists canonical provenance and prevents false confidence carry-forward", () => {
    for (const token of [
      "pricecharting_exact_tier",
      "pricecharting_compatible_tier",
      "pricecharting_estimate",
      "manual_guide",
      "manual_value",
      "tier_unavailable",
    ]) expect(consolidationSql).toContain(token);
    expect(consolidationSql).toContain("visual_confirmation_status = 'user_confirmed' then 'verified'");
    expect(consolidationSql).toContain("valuation_provenance set not null");
  });

  it("revokes PUBLIC/anon execution from the confirmation writer", () => {
    expect(confirmationSql).toContain("from public");
    expect(confirmationSql).toContain("from anon");
    expect(confirmationSql).toContain("to authenticated");
  });

  it("restricts infrastructure SECURITY DEFINER functions to service_role", () => {
    for (const signature of [
      "reserve_api_request_slot(text, integer)",
      "consume_daily_quota(text, integer)",
      "cgc_claim_import_run(uuid, uuid, text, jsonb, numeric)",
    ]) {
      expect(consolidationSql).toContain(`revoke all on function public.${signature} from authenticated`);
      expect(consolidationSql).toContain(`grant execute on function public.${signature} to service_role`);
    }
    expect(consolidationSql).toContain("revoke all on function public.rls_auto_enable() from authenticated");
    expect(consolidationSql).toContain("alter function public.valid_image_ext(text) set search_path = pg_catalog");
  });
});
