import { describe, it, expect, vi } from "vitest";
import {
  EBAY_OAUTH_SCOPES,
  buildAuthorizeQuery,
  ebayApizBase,
  resolveEbayCallback,
  resolveScopePersistence,
  refreshScopeParam,
  type CallbackDeps,
} from "../../../supabase/functions/_shared/ebay-oauth-core";

describe("scope provenance", () => {
  it("labels provider-reported scopes when eBay returns them", () => {
    const r = resolveScopePersistence(EBAY_OAUTH_SCOPES, ["https://api.ebay.com/oauth/api_scope", "https://api.ebay.com/oauth/api_scope/sell.account"]);
    expect(r.scope_source).toBe("provider_reported");
    expect(r.token_reported_scopes).toHaveLength(2);
    expect(r.requested_scopes).toEqual([...EBAY_OAUTH_SCOPES]);
  });
  it("falls back to the requested set (never empty) when eBay omits scope", () => {
    const r = resolveScopePersistence(EBAY_OAUTH_SCOPES, []);
    expect(r.scope_source).toBe("requested_fallback");
    expect(r.token_reported_scopes).toBeNull();
    expect(r.requested_scopes).toEqual([...EBAY_OAUTH_SCOPES]);
  });
  it("refresh always sends the canonical scopes and never an empty string", () => {
    expect(refreshScopeParam([], EBAY_OAUTH_SCOPES).split(" ")).toHaveLength(6);
    expect(refreshScopeParam(null, EBAY_OAUTH_SCOPES)).toContain("commerce.identity.readonly");
    expect(refreshScopeParam(["a", "b"], EBAY_OAUTH_SCOPES)).toBe("a b");
  });
});

describe("ebayApizBase", () => {
  it("targets the apiz gateway (the Identity API getUser is NOT on api.*)", () => {
    expect(ebayApizBase("sandbox")).toBe("https://apiz.sandbox.ebay.com");
    expect(ebayApizBase("production")).toBe("https://apiz.ebay.com");
  });
});

describe("buildAuthorizeQuery", () => {
  it("requests base + Identity + all four seller scopes (Identity exactly once)", () => {
    const scope = buildAuthorizeQuery({ clientId: "cid", ruName: "RU-NAME", state: "s", mode: "sandbox" }).get("scope") ?? "";
    const scopes = scope.split(" ");
    expect(scopes).toContain("https://api.ebay.com/oauth/api_scope"); // base
    expect(scopes).toContain("https://api.ebay.com/oauth/api_scope/commerce.identity.readonly"); // Identity (getUser)
    expect(scopes).toContain("https://api.ebay.com/oauth/api_scope/sell.account");
    expect(scopes).toContain("https://api.ebay.com/oauth/api_scope/sell.inventory");
    expect(scopes).toContain("https://api.ebay.com/oauth/api_scope/sell.fulfillment");
    expect(scopes).toContain("https://api.ebay.com/oauth/api_scope/sell.finances");
    // Identity scope appears exactly once.
    expect(scopes.filter((s) => s === "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly")).toHaveLength(1);
    expect(EBAY_OAUTH_SCOPES.length).toBe(6);
  });

  it("requests ONLY the minimum identity scope — never the PII identity scopes", () => {
    const scopes = EBAY_OAUTH_SCOPES as readonly string[];
    for (const pii of ["email", "phone", "address", "name", "status"]) {
      expect(scopes).not.toContain(`https://api.ebay.com/oauth/api_scope/commerce.identity.${pii}.readonly`);
    }
  });

  it("adds prompt=login in sandbox, not in production", () => {
    expect(buildAuthorizeQuery({ clientId: "c", ruName: "r", state: "s", mode: "sandbox" }).get("prompt")).toBe("login");
    expect(buildAuthorizeQuery({ clientId: "c", ruName: "r", state: "s", mode: "production" }).get("prompt")).toBeNull();
  });

  it("uses the RuName as redirect_uri and code response type", () => {
    const q = buildAuthorizeQuery({ clientId: "cid", ruName: "RU-NAME", state: "st8", mode: "production" });
    expect(q.get("redirect_uri")).toBe("RU-NAME");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("cid");
    expect(q.get("state")).toBe("st8");
  });
});

// A happy-path dep set; individual tests override one stage to fail.
function deps(over: Partial<CallbackDeps> = {}): CallbackDeps {
  return {
    exchangeCode: vi.fn(async () => ({ ok: true, status: 200, accessToken: "AT", refreshToken: "RT", scope: EBAY_OAUTH_SCOPES.slice(), refreshTokenExpiresInSec: 47304000 })),
    fetchIdentity: vi.fn(async () => ({ ok: true, ebayUserId: "user-123" })),
    persistAccount: vi.fn(async () => ({ ok: true, accountId: "acct-1" })),
    persistCredential: vi.fn(async () => ({ ok: true })),
    consumeState: vi.fn(async () => ({ ok: true })),
    confirmConsumed: vi.fn(async () => true),
    ...over,
  };
}

describe("resolveEbayCallback", () => {
  it("connects on the full happy path and consumes the state exactly once", async () => {
    const d = deps();
    const res = await resolveEbayCallback(d);
    expect(res).toEqual({ stage: "connected", query: "connected", upstreamStatus: undefined });
    expect(d.consumeState).toHaveBeenCalledTimes(1);
    expect(d.confirmConsumed).toHaveBeenCalledTimes(1);
  });

  it("token exchange failure → token_exchange_failed, identity + consume never run", async () => {
    const d = deps({ exchangeCode: vi.fn(async () => ({ ok: false, status: 400 })) });
    const res = await resolveEbayCallback(d);
    expect(res).toMatchObject({ stage: "token_exchange_failed", query: "error", upstreamStatus: 400 });
    expect(d.fetchIdentity).not.toHaveBeenCalled();
    expect(d.consumeState).not.toHaveBeenCalled();
  });

  it("missing refresh token → missing_refresh_token", async () => {
    const d = deps({ exchangeCode: vi.fn(async () => ({ ok: true, accessToken: "AT", refreshToken: "" })) });
    expect((await resolveEbayCallback(d)).stage).toBe("missing_refresh_token");
    expect(d.consumeState).not.toHaveBeenCalled();
  });

  it("Identity HTTP 403 → identity_scope_missing and the state is NOT consumed", async () => {
    const d = deps({ fetchIdentity: vi.fn(async () => ({ ok: false, status: 403 })) });
    const res = await resolveEbayCallback(d);
    expect(res).toMatchObject({ stage: "identity_scope_missing", query: "identity_scope_missing", upstreamStatus: 403 });
    expect(d.persistAccount).not.toHaveBeenCalled();
    expect(d.consumeState).not.toHaveBeenCalled(); // retry can still succeed
  });

  it("other Identity failure → identity_request_failed", async () => {
    const d = deps({ fetchIdentity: vi.fn(async () => ({ ok: false, status: 500 })) });
    expect((await resolveEbayCallback(d)).stage).toBe("identity_request_failed");
  });

  it("empty user id → identity_unavailable", async () => {
    const d = deps({ fetchIdentity: vi.fn(async () => ({ ok: true, ebayUserId: "" })) });
    expect((await resolveEbayCallback(d)).stage).toBe("identity_unavailable");
    expect(d.consumeState).not.toHaveBeenCalled();
  });

  it("account persist failure → account_persist_failed, state not consumed", async () => {
    const d = deps({ persistAccount: vi.fn(async () => ({ ok: false })) });
    expect((await resolveEbayCallback(d)).query).toBe("persist_error");
    expect(d.consumeState).not.toHaveBeenCalled();
  });

  it("credential persist failure → NEVER reports connected, state not consumed", async () => {
    const d = deps({ persistCredential: vi.fn(async () => ({ ok: false })) });
    const res = await resolveEbayCallback(d);
    expect(res.stage).toBe("credential_persist_failed");
    expect(res.query).not.toBe("connected");
    expect(d.consumeState).not.toHaveBeenCalled();
  });

  it("scope-metadata persist failure → scope_persist_failed, state not consumed", async () => {
    const d = deps({ persistCredential: vi.fn(async () => ({ ok: false, stage: "scope_persist_failed" as const })) });
    const res = await resolveEbayCallback(d);
    expect(res.stage).toBe("scope_persist_failed");
    expect(res.query).toBe("persist_error");
    expect(d.consumeState).not.toHaveBeenCalled();
  });

  it("consume error or unconfirmed consumption → state_consume_failed (not connected)", async () => {
    expect((await resolveEbayCallback(deps({ consumeState: vi.fn(async () => ({ ok: false })) }))).stage).toBe("state_consume_failed");
    const d = deps({ confirmConsumed: vi.fn(async () => false) });
    const res = await resolveEbayCallback(d);
    expect(res.stage).toBe("state_consume_failed");
    expect(res.query).not.toBe("connected");
  });
});
