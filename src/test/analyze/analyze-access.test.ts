import { describe, expect, it } from "vitest";
import {
  decideAnalyzeAccess,
  type AnalyzeCallerFacts,
} from "../../../supabase/functions/_shared/analyze-access";

function facts(overrides: Partial<AnalyzeCallerFacts> = {}): AnalyzeCallerFacts {
  return {
    user: { id: "user-1", emailConfirmed: true },
    isAdmin: false,
    profile: { ok: true, accountStatus: "active" },
    ...overrides,
  };
}

describe("decideAnalyzeAccess", () => {
  it("allows an active, email-confirmed customer", () => {
    expect(decideAnalyzeAccess(facts())).toEqual({ allowed: true, role: "customer" });
  });

  it("allows an admin without customer-profile requirements", () => {
    const decision = decideAnalyzeAccess(
      facts({ isAdmin: true, profile: { ok: false }, user: { id: "a", emailConfirmed: false } }),
    );
    expect(decision).toEqual({ allowed: true, role: "admin" });
  });

  it("denies anonymous callers", () => {
    const decision = decideAnalyzeAccess(facts({ user: null }));
    expect(decision).toMatchObject({ allowed: false, statusCode: 401, errorCode: "NOT_AUTHENTICATED" });
  });

  it("denies unconfirmed customers", () => {
    const decision = decideAnalyzeAccess(facts({ user: { id: "u", emailConfirmed: false } }));
    expect(decision).toMatchObject({ allowed: false, statusCode: 403, errorCode: "EMAIL_NOT_CONFIRMED" });
  });

  it("denies customers with no profile row", () => {
    const decision = decideAnalyzeAccess(facts({ profile: { ok: true, accountStatus: null } }));
    expect(decision).toMatchObject({ allowed: false, statusCode: 403, errorCode: "NO_CUSTOMER_PROFILE" });
  });

  it("denies suspended and closed customers", () => {
    for (const accountStatus of ["suspended", "closed", "pending_verification"]) {
      const decision = decideAnalyzeAccess(facts({ profile: { ok: true, accountStatus } }));
      expect(decision).toMatchObject({ allowed: false, statusCode: 403, errorCode: "ACCOUNT_NOT_ACTIVE" });
    }
  });

  it("fails closed when the profile lookup errors", () => {
    const decision = decideAnalyzeAccess(facts({ profile: { ok: false } }));
    expect(decision).toMatchObject({ allowed: false, statusCode: 503, errorCode: "ACCOUNT_LOOKUP_FAILED" });
  });
});
