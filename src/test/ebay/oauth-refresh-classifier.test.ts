import { describe, expect, it } from "vitest";
import { classifyOAuthRefreshFailure } from "../../../supabase/functions/_shared/ebay-oauth-refresh-classifier";

describe("eBay OAuth refresh classification", () => {
  it("requires reconnect only for an explicit invalid_grant or missing credential", () => {
    for (const input of [{ providerError: "invalid_grant", httpStatus: 400 }, { missingCredential: true }]) {
      const result = classifyOAuthRefreshFailure(input);
      expect(result.status).toBe("reauthorization_required");
      expect(result.reconnectRequired).toBe(true);
      expect(result.retryable).toBe(false);
    }
  });

  it("keeps rate limits, network failures, and provider 5xx retryable without reconnect", () => {
    for (const input of [{ httpStatus: 429 }, { networkError: true }, { httpStatus: 503 }]) {
      const result = classifyOAuthRefreshFailure(input);
      expect(result.status).toBe("temporary_failure");
      expect(result.retryable).toBe(true);
      expect(result.reconnectRequired).toBe(false);
    }
  });

  it("separates configuration failures from credential rejection", () => {
    const local = classifyOAuthRefreshFailure({ configurationError: true });
    const provider = classifyOAuthRefreshFailure({ providerError: "invalid_client", httpStatus: 401 });
    expect(local.errorCode).toBe("oauth_configuration_error");
    expect(provider.errorCode).toBe("oauth_configuration_error");
    expect(local.reconnectRequired).toBe(false);
    expect(provider.reconnectRequired).toBe(false);
  });

  it("treats rotation persistence and malformed success responses as retryable", () => {
    expect(classifyOAuthRefreshFailure({ persistenceError: true })).toMatchObject({ retryable: true, reconnectRequired: false, errorCode: "credential_persistence_failed" });
    expect(classifyOAuthRefreshFailure({ invalidResponse: true, httpStatus: 200 })).toMatchObject({ retryable: true, reconnectRequired: false, errorCode: "oauth_invalid_response" });
  });

  it("never echoes provider descriptions or payloads", () => {
    const result = classifyOAuthRefreshFailure({ providerError: "unknown_provider_code", httpStatus: 400 } as never);
    expect(JSON.stringify(result)).not.toContain("provider_description");
    expect(result.errorCode).toBe("oauth_refresh_rejected");
  });
});
