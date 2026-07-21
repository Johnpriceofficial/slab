import { describe, it, expect } from "vitest";
import { ebayCallbackResultMessage } from "@/lib/slabs/ebay-callback";

describe("ebayCallbackResultMessage", () => {
  it("maps success and decline outcomes", () => {
    expect(ebayCallbackResultMessage("connected")).toEqual({ tone: "success", message: expect.stringContaining("connected") });
    expect(ebayCallbackResultMessage("denied").tone).toBe("info");
  });

  it("surfaces every failure marker as an error with a distinct message", () => {
    const markers = ["invalid_state", "invalid_callback", "config_error", "identity_scope_missing", "identity_unavailable", "scope_persist_failed", "persist_error", "error"];
    const messages = new Set<string>();
    for (const m of markers) {
      const r = ebayCallbackResultMessage(m);
      expect(r.tone).toBe("error");
      messages.add(r.message);
    }
    expect(messages.size).toBe(markers.length); // each marker has a distinct message
  });

  it("gives scope_persist_failed a distinct, actionable message (not finalized)", () => {
    const r = ebayCallbackResultMessage("scope_persist_failed");
    expect(r.tone).toBe("error");
    expect(r.message).toMatch(/not finalized|scope metadata|could not be saved/i);
  });

  it("gives the identity-scope error an actionable reconnect hint", () => {
    expect(ebayCallbackResultMessage("identity_scope_missing").message).toMatch(/permission/i);
  });

  it("falls back to a generic error for unknown markers", () => {
    expect(ebayCallbackResultMessage("something-else")).toEqual({ tone: "error", message: expect.stringContaining("failed") });
  });
});
