import { describe, expect, it, vi } from "vitest";
import {
  handleEbayDisconnect,
  isEbayDisconnectEnabled,
  parseDisconnectInput,
  type EbayDisconnectDeps,
} from "../../../supabase/functions/_shared/ebay-disconnect-core";

const ACCOUNT_ID = "11111111-2222-3333-4444-555555555555";

function request(body: unknown = { account_id: ACCOUNT_ID }, method = "POST"): Request {
  return new Request("https://example.test/functions/v1/ebay-disconnect", {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

function deps(overrides: Partial<EbayDisconnectDeps> = {}): EbayDisconnectDeps {
  return {
    checkAdmin: async () => ({ user: { id: "admin" }, isAdmin: true }),
    deleteCredential: async () => {},
    disconnectEnabled: true,
    corsHeaders: { "access-control-allow-origin": "*" },
    ...overrides,
  };
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("eBay disconnect core", () => {
  it("keeps the server-only disconnect switch default-off", () => {
    expect(isEbayDisconnectEnabled(undefined)).toBe(false);
    expect(isEbayDisconnectEnabled(null)).toBe(false);
    expect(isEbayDisconnectEnabled("")).toBe(false);
    expect(isEbayDisconnectEnabled("false")).toBe(false);
    expect(isEbayDisconnectEnabled("1")).toBe(false);
    expect(isEbayDisconnectEnabled(" true ")).toBe(true);
  });

  it("validates and normalizes the account UUID", () => {
    expect(parseDisconnectInput({ account_id: ` ${ACCOUNT_ID.toUpperCase()} ` })).toEqual({
      ok: true,
      accountId: ACCOUNT_ID,
    });
    expect(parseDisconnectInput({})).toMatchObject({ ok: false, errorCode: "INVALID_ACCOUNT_ID" });
    expect(parseDisconnectInput({ account_id: "not-a-uuid" })).toMatchObject({
      ok: false,
      errorCode: "INVALID_ACCOUNT_ID",
    });
  });

  it("answers CORS preflight without attempting authorization or deletion", async () => {
    const checkAdmin = vi.fn();
    const deleteCredential = vi.fn();
    const response = await handleEbayDisconnect(
      new Request("https://example.test/functions/v1/ebay-disconnect", { method: "OPTIONS" }),
      deps({ checkAdmin, deleteCredential }),
    );
    expect(response.status).toBe(200);
    expect(checkAdmin).not.toHaveBeenCalled();
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("rejects unsupported methods", async () => {
    const response = await handleEbayDisconnect(request(undefined, "GET"), deps());
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, OPTIONS");
    expect(await responseJson(response)).toMatchObject({ error_code: "METHOD_NOT_ALLOWED" });
  });

  it("returns 401 when no verified user exists", async () => {
    const response = await handleEbayDisconnect(
      request(),
      deps({ checkAdmin: async () => ({ user: null, isAdmin: false }) }),
    );
    expect(response.status).toBe(401);
    expect(await responseJson(response)).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 for a verified non-admin", async () => {
    const response = await handleEbayDisconnect(
      request(),
      deps({ checkAdmin: async () => ({ user: { id: "customer" }, isAdmin: false }) }),
    );
    expect(response.status).toBe(403);
    expect(await responseJson(response)).toEqual({ error: "Forbidden" });
  });

  it("does not call the RPC while the default-off switch is disabled", async () => {
    const deleteCredential = vi.fn();
    const response = await handleEbayDisconnect(
      request(),
      deps({ disconnectEnabled: false, deleteCredential }),
    );
    expect(response.status).toBe(403);
    expect(await responseJson(response)).toEqual({
      status: "mutation_disabled",
      operation: "disconnect",
      kind: "credential",
      message: "eBay credential disconnect is disabled by server configuration.",
    });
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and invalid account ids without calling the RPC", async () => {
    const deleteCredential = vi.fn();
    const malformed = new Request("https://example.test/functions/v1/ebay-disconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const malformedResponse = await handleEbayDisconnect(
      malformed,
      deps({ deleteCredential }),
    );
    expect(malformedResponse.status).toBe(400);
    expect(await responseJson(malformedResponse)).toMatchObject({ error_code: "INVALID_JSON" });

    const invalidResponse = await handleEbayDisconnect(
      request({ account_id: "invalid" }),
      deps({ deleteCredential }),
    );
    expect(invalidResponse.status).toBe(400);
    expect(await responseJson(invalidResponse)).toMatchObject({ error_code: "INVALID_ACCOUNT_ID" });
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("returns a fixed sanitized success body", async () => {
    const deleteCredential = vi.fn(async () => {});
    const response = await handleEbayDisconnect(request(), deps({ deleteCredential }));
    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({ status: "disconnected" });
    expect(deleteCredential).toHaveBeenCalledExactlyOnceWith(ACCOUNT_ID);
  });

  it("fails closed without leaking database or credential details", async () => {
    const deleteCredential = vi.fn(async () => {
      throw new Error("refresh_token_encrypted=secret-database-detail");
    });
    const response = await handleEbayDisconnect(request(), deps({ deleteCredential }));
    expect(response.status).toBe(503);
    const body = await responseJson(response);
    expect(body).toEqual({
      status: "error",
      error_code: "DISCONNECT_FAILED",
      message: "The eBay account could not be disconnected.",
    });
    expect(JSON.stringify(body)).not.toContain("refresh_token");
    expect(JSON.stringify(body)).not.toContain("secret-database-detail");
  });
});
