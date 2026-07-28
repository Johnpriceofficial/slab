/**
 * Customer-authorization decision for analyze-slab.
 *
 * Pure and dependency-free so the exact production decision table is
 * unit-tested from vitest while the Deno Edge Function executes the same
 * code. The caller supplies facts (verified JWT user, admin check result,
 * profile lookup outcome); this module only decides.
 *
 * Identity always comes from the verified JWT — a user id in the request
 * body is never accepted anywhere in this flow.
 */

export interface AnalyzeCallerFacts {
  /** Verified JWT user, or null when the token is missing/invalid. */
  user: { id: string; emailConfirmed: boolean } | null;
  /** Result of the server-side is_admin() check for that user. */
  isAdmin: boolean;
  /**
   * Customer-profile lookup outcome (service-role read, keyed by the JWT
   * user id). `failed` means the lookup itself errored — which must fail
   * closed, never open.
   */
  profile: { ok: true; accountStatus: string | null } | { ok: false };
}

export type AnalyzeAccessDecision =
  | { allowed: true; role: "admin" | "customer" }
  | { allowed: false; statusCode: number; errorCode: string; message: string };

function deny(statusCode: number, errorCode: string, message: string): AnalyzeAccessDecision {
  return { allowed: false, statusCode, errorCode, message };
}

export function decideAnalyzeAccess(facts: AnalyzeCallerFacts): AnalyzeAccessDecision {
  if (!facts.user) {
    return deny(401, "NOT_AUTHENTICATED", "Sign in to analyze a slab.");
  }
  if (facts.isAdmin) {
    // Existing administrative access is preserved unchanged.
    return { allowed: true, role: "admin" };
  }
  if (!facts.user.emailConfirmed) {
    return deny(403, "EMAIL_NOT_CONFIRMED", "Verify your email before analyzing slabs.");
  }
  if (!facts.profile.ok) {
    // A failed lookup is indistinguishable from an unverifiable account:
    // fail closed rather than letting unverified traffic reach the provider.
    return deny(503, "ACCOUNT_LOOKUP_FAILED", "Account status could not be verified.");
  }
  if (facts.profile.accountStatus === null) {
    return deny(403, "NO_CUSTOMER_PROFILE", "No customer profile exists for this account.");
  }
  if (facts.profile.accountStatus !== "active") {
    return deny(403, "ACCOUNT_NOT_ACTIVE", "This customer account is not active.");
  }
  return { allowed: true, role: "customer" };
}
