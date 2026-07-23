// Pure, cross-runtime classification for eBay user-token refresh failures.
//
// The provider's raw response body and error_description are never returned or
// logged. Only a small allowlisted error code, HTTP class, retryability, and
// reconnect requirement leave this module. This keeps browser messaging useful
// without exposing tokens, credentials, provider payloads, or account details.

export type OAuthRefreshStatus =
  | "reauthorization_required"
  | "temporary_failure"
  | "configuration_error"
  | "error";

export interface OAuthRefreshFailureInput {
  httpStatus?: number | null;
  providerError?: string | null;
  networkError?: boolean;
  configurationError?: boolean;
  missingCredential?: boolean;
  invalidResponse?: boolean;
  persistenceError?: boolean;
}

export interface OAuthRefreshClassification {
  status: OAuthRefreshStatus;
  errorCode:
    | "reauthorization_required"
    | "oauth_rate_limited"
    | "oauth_provider_unavailable"
    | "oauth_network_error"
    | "oauth_configuration_error"
    | "oauth_invalid_response"
    | "credential_persistence_failed"
    | "oauth_refresh_rejected";
  retryable: boolean;
  reconnectRequired: boolean;
  httpStatus: number;
  message: string;
}

const reconnectErrors = new Set(["invalid_grant", "invalid_token", "invalid_refresh_token"]);
const configurationErrors = new Set(["invalid_client", "unauthorized_client", "unsupported_grant_type"]);
const temporaryErrors = new Set(["temporarily_unavailable", "server_error", "slow_down"]);

function normalized(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Classify one failed refresh attempt. Reauthorization is reserved for an actual
 * credential rejection (missing credential or an explicit invalid_grant/token
 * response). Rate limits, network failures, local configuration defects, provider
 * 5xx responses, malformed 2xx responses, and persistence failures never mark the
 * account as requiring reconnect.
 */
export function classifyOAuthRefreshFailure(input: OAuthRefreshFailureInput): OAuthRefreshClassification {
  const providerError = normalized(input.providerError);
  const http = input.httpStatus ?? 0;

  if (input.missingCredential || reconnectErrors.has(providerError)) {
    return {
      status: "reauthorization_required",
      errorCode: "reauthorization_required",
      retryable: false,
      reconnectRequired: true,
      httpStatus: 409,
      message: "The saved eBay authorization is no longer valid. Reconnect eBay to continue.",
    };
  }

  if (input.configurationError || configurationErrors.has(providerError)) {
    return {
      status: "configuration_error",
      errorCode: "oauth_configuration_error",
      retryable: false,
      reconnectRequired: false,
      httpStatus: 500,
      message: "The eBay OAuth server configuration is incomplete or invalid.",
    };
  }

  if (input.persistenceError) {
    return {
      status: "temporary_failure",
      errorCode: "credential_persistence_failed",
      retryable: true,
      reconnectRequired: false,
      httpStatus: 503,
      message: "The refreshed eBay credential could not be saved. Retry after the database is healthy.",
    };
  }

  if (http === 429 || providerError === "slow_down") {
    return {
      status: "temporary_failure",
      errorCode: "oauth_rate_limited",
      retryable: true,
      reconnectRequired: false,
      httpStatus: 429,
      message: "eBay temporarily rate-limited the authorization refresh. Retry shortly.",
    };
  }

  if (input.networkError) {
    return {
      status: "temporary_failure",
      errorCode: "oauth_network_error",
      retryable: true,
      reconnectRequired: false,
      httpStatus: 503,
      message: "The eBay authorization service could not be reached. Retry shortly.",
    };
  }

  if (http >= 500 || temporaryErrors.has(providerError)) {
    return {
      status: "temporary_failure",
      errorCode: "oauth_provider_unavailable",
      retryable: true,
      reconnectRequired: false,
      httpStatus: 503,
      message: "eBay's authorization service is temporarily unavailable. Retry shortly.",
    };
  }

  if (input.invalidResponse) {
    return {
      status: "temporary_failure",
      errorCode: "oauth_invalid_response",
      retryable: true,
      reconnectRequired: false,
      httpStatus: 502,
      message: "eBay returned an incomplete authorization response. Retry shortly.",
    };
  }

  return {
    status: "error",
    errorCode: "oauth_refresh_rejected",
    retryable: false,
    reconnectRequired: false,
    httpStatus: 502,
    message: "eBay rejected the authorization refresh without indicating that reconnection is required.",
  };
}
