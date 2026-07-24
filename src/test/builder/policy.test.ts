import { describe, it, expect } from "vitest";
import { evaluatePolicy, mayExecuteImmediately, requiresHumanGate } from "../../builder/policy";
import type { PolicyContext } from "../../builder/types";

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({ sessionMode: "read_only", environment: "development", ...over });

describe("evaluatePolicy — the four-level model", () => {
  it("read is always automatic, even in a read-only session", () => {
    expect(evaluatePolicy("read", ctx({ sessionMode: "read_only" }))).toBe("auto");
    expect(evaluatePolicy("read", ctx({ sessionMode: "allow_all_nondestructive" }))).toBe("auto");
  });

  it("preview_write needs a session grant, else an explicit approval", () => {
    expect(evaluatePolicy("preview_write", ctx({ sessionMode: "read_only" }))).toBe("explicit_approval");
    expect(evaluatePolicy("preview_write", ctx({ sessionMode: "allow_preview" }))).toBe("session_approval");
    expect(evaluatePolicy("preview_write", ctx({ sessionMode: "allow_all_nondestructive" }))).toBe("session_approval");
  });

  it("production_write ALWAYS needs an explicit approval — a session grant never auto-approves prod", () => {
    for (const sessionMode of ["read_only", "allow_preview", "allow_all_nondestructive"] as const) {
      expect(evaluatePolicy("production_write", ctx({ sessionMode, environment: "production" }))).toBe("explicit_approval");
    }
  });

  it("destructive requires typed confirmation, and is DENIED when the environment forbids it", () => {
    expect(evaluatePolicy("destructive", ctx({ allowDestructive: true }))).toBe("typed_confirmation");
    expect(evaluatePolicy("destructive", ctx({ allowDestructive: false }))).toBe("denied");
    expect(evaluatePolicy("destructive", ctx())).toBe("denied"); // default forbids destructive
  });

  it("requiresApproval only ESCALATES — it never weakens the mapping", () => {
    expect(evaluatePolicy("read", ctx(), true)).toBe("explicit_approval");              // auto → explicit
    expect(evaluatePolicy("preview_write", ctx({ sessionMode: "allow_all_nondestructive" }), true)).toBe("explicit_approval"); // session → explicit
    expect(evaluatePolicy("production_write", ctx(), true)).toBe("explicit_approval");  // stays explicit
    expect(evaluatePolicy("destructive", ctx({ allowDestructive: true }), true)).toBe("typed_confirmation"); // not weakened
    expect(evaluatePolicy("destructive", ctx({ allowDestructive: false }), true)).toBe("denied"); // denial never overridden
  });
});

describe("decision helpers", () => {
  it("only auto + session_approval may execute immediately", () => {
    expect(mayExecuteImmediately("auto")).toBe(true);
    expect(mayExecuteImmediately("session_approval")).toBe(true);
    expect(mayExecuteImmediately("explicit_approval")).toBe(false);
    expect(mayExecuteImmediately("typed_confirmation")).toBe(false);
    expect(mayExecuteImmediately("denied")).toBe(false);
  });
  it("explicit_approval + typed_confirmation require a human gate", () => {
    expect(requiresHumanGate("explicit_approval")).toBe(true);
    expect(requiresHumanGate("typed_confirmation")).toBe(true);
    expect(requiresHumanGate("auto")).toBe(false);
    expect(requiresHumanGate("denied")).toBe(false);
  });
});
