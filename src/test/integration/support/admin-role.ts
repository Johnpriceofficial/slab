import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Seed the canonical administrator role for a freshly minted test user.
 *
 * After migration 20260910 (admin-authority unification), `public.is_admin()`
 * derives administrator status from `public.user_roles` only — user-editable
 * `raw_app_meta_data.graded_card_value_admin` and the staged `slab_admins`
 * allowlist are no longer authoritative for a *newly* created account (the
 * one-time backfill runs at migration time, not for users created afterwards).
 *
 * Integration fixtures that mint an administrator must therefore grant the
 * canonical role explicitly. Idempotent: safe to call more than once.
 */
export async function grantAdministrator(
  service: SupabaseClient,
  userId: string,
): Promise<void> {
  const { error } = await service
    .from("user_roles")
    .upsert({ user_id: userId, role: "administrator" }, { onConflict: "user_id,role" });
  if (error) {
    throw new Error(`grantAdministrator(${userId}) failed: ${error.message}`);
  }
}
