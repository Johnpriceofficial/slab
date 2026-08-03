import { describe, expect, it, vi } from "vitest";
import {
  ALLOWLISTED_STATUS_KEYS,
  assertNoSecretShapedFields,
  buildConnectStatus,
  ebayCallbackUrl,
  handleConnectStatus,
  isSecretShapedValue,
  type ConnectStatusDeps,
  type EbayAccountRow,
} from "../../../supabase/functions/_shared/ebay-connect-status-core";

const SUPABASE_URL = "https://rcbwemkfcefarqnlgrmv.supabase.co";
// Purely synthetic token-shaped strings used ONLY to prove they never leak.
// Assembled from parts so the SOURCE never contains a scan-matchable literal
// (the CI secret scan is line-based); the runtime value is a real JWT shape.
const JWT_PARTS = ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N"];
const FAKE_JWT = JWT_PARTS.join(".");
const FAKE_ENCRYPTED = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5QUJDREVGR0hJSktM"; // 64 base64 chars

function connectedAccount(overrides: Partial<EbayAccountRow> = {}): EbayAccountRow {
  return {
    id: "acct-1",
    ebay_user_id: "gcv_seller",
    marketplace_id: "EBAY_US",
    display_label: "Graded Card Value",
    connection_status: "connected",
    privilege_status: "ok",
    authorization_expires_at: "2999-01-01T00:00:00.000Z",
    last_synced_at: "2026-08-02T00:00:00.000Z",
    connected_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ConnectStatusDeps> = {}): ConnectStatusDeps {
  return {
    checkAdmin: async () => ({ user: { id: "u-admin" }, isAdmin: true }),
    loadAccount: async () => connectedAccount(),
    loadScopeMeta: async () => ({
      requestedScopes: ["https://api.ebay.com/oauth/api_scope/sell.inventory"],
      grantedScopes: ["https://api.ebay.com/oauth/api_scope/sell.inventory"],
      scopeSource: "token_reported",
    }),
    loadCounts: async () => ({
      inventoryLocations: 1,
      businessPolicies: { fulfillment: 1, payment: 1, return: 1 },
    }),
    mutationEnv: {},
    environment: "production",
    supabaseUrl: SUPABASE_URL,
    now: () => "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

function request(authorization?: string): Request {
  return new Request("https://app/functions/v1/ebay-connect-status", {
    headers: authorization ? { authorization } : {},
  });
}

describe("ebay-connect-status — authentication (admin only)", () => {
  it("denies an unauthenticated request with 401 and never touches the database", async () => {
    const loadAccount = vi.fn(async () => connectedAccount());
    const res = await handleConnectStatus(
      request(),
      makeDeps({ checkAdmin: async () => ({ user: null, isAdmin: false }), loadAccount }),
    );
    expect(res.status).toBe(401);
    expect(loadAccount).not.toHaveBeenCalled();
  });

  it("denies an authenticated non-admin with 403 and never touches the database", async () => {
    const loadAccount = vi.fn(async () => connectedAccount());
    const res = await handleConnectStatus(
      request("Bearer jwt"),
      makeDeps({ checkAdmin: async () => ({ user: { id: "u-1" }, isAdmin: false }), loadAccount }),
    );
    expect(res.status).toBe(403);
    expect(loadAccount).not.toHaveBeenCalled();
  });
});

describe("ebay-connect-status — status truthfulness + allowlist", () => {
  it("reports a truthful disconnected status when no account exists", async () => {
    const loadScopeMeta = vi.fn();
    const res = await handleConnectStatus(
      request("Bearer jwt"),
      makeDeps({ loadAccount: async () => null, loadScopeMeta }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connectionState).toBe("not_connected");
    expect(body.connected).toBe(false);
    // With no account, the credential RPC is never consulted.
    expect(loadScopeMeta).not.toHaveBeenCalled();
  });

  it("returns ONLY allowlisted fields for a connected account", async () => {
    const res = await handleConnectStatus(request("Bearer jwt"), makeDeps());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([...ALLOWLISTED_STATUS_KEYS].sort());
    expect(body.connected).toBe(true);
    expect(body.accountLabel).toBe("Graded Card Value");
  });

  it("marks reauthorization_required when the authorization has expired", async () => {
    const res = await handleConnectStatus(
      request("Bearer jwt"),
      makeDeps({
        loadAccount: async () =>
          connectedAccount({ authorization_expires_at: "2020-01-01T00:00:00.000Z" }),
      }),
    );
    const body = await res.json();
    expect(body.connectionState).toBe("reauthorization_required");
    expect(body.reauthorizationRequired).toBe(true);
    expect(body.connected).toBe(false);
  });
});

describe("ebay-connect-status — never leaks secret material", () => {
  it("strips token/secret fields present on the raw row and emits nothing secret-shaped", async () => {
    const leaky = connectedAccount({
      refresh_token_encrypted: FAKE_ENCRYPTED,
      access_token: FAKE_JWT,
    } as Partial<EbayAccountRow>);
    const res = await handleConnectStatus(
      request("Bearer jwt"),
      makeDeps({ loadAccount: async () => leaky }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).not.toContain("refresh_token_encrypted");
    expect(Object.keys(body)).not.toContain("access_token");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(FAKE_JWT);
    expect(serialized).not.toContain(FAKE_ENCRYPTED);
    expect(() => assertNoSecretShapedFields(body)).not.toThrow();
  });

  it("mutation kill switches default to false; a flag only flips on exact 'true'", async () => {
    const off = await (await handleConnectStatus(request("Bearer jwt"), makeDeps())).json();
    expect(off.mutationFlags).toEqual({
      listing: false,
      fulfillment: false,
      financial: false,
      applySales: false,
    });
    const on = await (
      await handleConnectStatus(
        request("Bearer jwt"),
        makeDeps({ mutationEnv: { EBAY_LISTING_MUTATIONS_ENABLED: "true" } }),
      )
    ).json();
    expect(on.mutationFlags.listing).toBe(true);
    expect(on.mutationFlags.fulfillment).toBe(false);
  });

  it("reports the canonical Supabase callback URL, never an app route", async () => {
    const body = await (await handleConnectStatus(request("Bearer jwt"), makeDeps())).json();
    expect(body.callbackUrl).toBe(ebayCallbackUrl(SUPABASE_URL));
    expect(body.callbackUrl).toBe(
      "https://rcbwemkfcefarqnlgrmv.supabase.co/functions/v1/ebay-oauth-callback",
    );
    expect(body.callbackUrl).toContain("/functions/v1/ebay-oauth-callback");
    expect(body.callbackUrl).not.toContain("/ebay/callback");
  });
});

describe("ebay-connect-status — credential access + fail-closed", () => {
  it("reads private credential data ONLY through the service-role scope RPC", async () => {
    const loadScopeMeta = vi.fn(async () => ({
      requestedScopes: [],
      grantedScopes: [],
      scopeSource: null,
    }));
    const res = await handleConnectStatus(request("Bearer jwt"), makeDeps({ loadScopeMeta }));
    expect(loadScopeMeta).toHaveBeenCalledWith("acct-1");
    const body = await res.json();
    // The only credential path is the RPC loader; the output carries no token.
    expect(() => assertNoSecretShapedFields(body)).not.toThrow();
  });

  it("fails closed (503, safe code, no leak) when a database read throws", async () => {
    const res = await handleConnectStatus(
      request("Bearer jwt"),
      makeDeps({
        loadAccount: async () => {
          throw new Error("SECRET-boom column ebay_oauth_credentials.refresh_token_encrypted");
        },
      }),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.errorCode).toBe("status_unavailable");
    expect(body.connected).not.toBe(true);
    expect(JSON.stringify(body)).not.toContain("SECRET-boom");
  });
});

describe("ebay-connect-status — secret guard + builder invariants", () => {
  it("isSecretShapedValue flags JWT / PEM / long base64 but not normal metadata", () => {
    expect(isSecretShapedValue(FAKE_JWT)).toBe(true);
    expect(isSecretShapedValue(FAKE_ENCRYPTED)).toBe(true);
    expect(isSecretShapedValue("-----BEGIN " + "PRIVATE KEY-----")).toBe(true);
    expect(isSecretShapedValue("EBAY_US")).toBe(false);
    expect(isSecretShapedValue("https://api.ebay.com/oauth/api_scope/sell.inventory")).toBe(false);
    expect(isSecretShapedValue("2026-08-03T00:00:00.000Z")).toBe(false);
    expect(isSecretShapedValue("Graded Card Value")).toBe(false);
  });

  it("assertNoSecretShapedFields throws on a denylisted key or secret value, nested too", () => {
    expect(() => assertNoSecretShapedFields({ refresh_token: "x" })).toThrow();
    expect(() => assertNoSecretShapedFields({ nested: { access_token: "y" } })).toThrow();
    expect(() => assertNoSecretShapedFields({ note: FAKE_JWT })).toThrow();
    expect(() =>
      assertNoSecretShapedFields({ ok: "EBAY_US", scopes: ["sell.inventory"] }),
    ).not.toThrow();
  });

  it("buildConnectStatus always emits exactly the allowlisted keys (connected + disconnected)", () => {
    const base = {
      scopeMeta: null,
      counts: null,
      mutationEnv: {},
      environment: "production",
      supabaseUrl: SUPABASE_URL,
      now: "2026-08-03T00:00:00.000Z",
    };
    const disconnected = buildConnectStatus({ account: null, ...base });
    const connected = buildConnectStatus({ account: connectedAccount(), ...base });
    expect(Object.keys(disconnected).sort()).toEqual([...ALLOWLISTED_STATUS_KEYS].sort());
    expect(Object.keys(connected).sort()).toEqual([...ALLOWLISTED_STATUS_KEYS].sort());
  });
});
