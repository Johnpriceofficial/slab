// Pure, cross-runtime eBay OAuth helpers: the authorization scope set + query
// builder, and a fully-injectable callback orchestrator. No Deno/npm imports, so
// the exact scope set, prompt handling, and every callback failure stage are
// unit-tested from src/test/ebay without a live eBay connection.

// The BASE/default scope is REQUIRED: eBay's Identity API (getUser) returns the
// opaque user id only when the token carries `api_scope`. Requesting only the
// sell.* scopes yields a 403 on identity and the connection silently fails.
export const EBAY_OAUTH_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.finances",
] as const;

export function buildAuthorizeQuery(args: {
  clientId: string;
  ruName: string;
  state: string;
  mode: "sandbox" | "production";
}): URLSearchParams {
  const q = new URLSearchParams({
    client_id: args.clientId,
    response_type: "code",
    redirect_uri: args.ruName, // eBay uses the RuName token as the redirect_uri
    scope: EBAY_OAUTH_SCOPES.join(" "),
    state: args.state,
  });
  // In sandbox, force a fresh login so a remembered sandbox session cannot
  // silently authorize the wrong test account.
  if (args.mode === "sandbox") q.set("prompt", "login");
  return q;
}

export type CallbackStage =
  | "connected"
  | "token_exchange_failed"
  | "missing_refresh_token"
  | "identity_request_failed"
  | "identity_scope_missing"
  | "identity_unavailable"
  | "account_persist_failed"
  | "credential_persist_failed"
  | "state_consume_failed";

export interface StageOutcome {
  stage: CallbackStage;
  query: string; // the ?ebay=<query> marker the browser redirect carries
  upstreamStatus?: number;
}

export interface CallbackDeps {
  exchangeCode: () => Promise<{ ok: boolean; status?: number; accessToken?: string; refreshToken?: string; scope?: string[]; refreshTokenExpiresInSec?: number | null }>;
  fetchIdentity: (accessToken: string) => Promise<{ ok: boolean; status?: number; ebayUserId?: string }>;
  persistAccount: (ebayUserId: string, refreshTokenExpiresInSec: number | null) => Promise<{ ok: boolean; accountId?: string }>;
  persistCredential: (accountId: string, refreshToken: string, scope: string[], refreshTokenExpiresInSec: number | null) => Promise<{ ok: boolean }>;
  consumeState: () => Promise<{ ok: boolean }>;
  confirmConsumed: () => Promise<boolean>;
}

// Failure stages map to a small, non-sensitive set of browser markers.
const QUERY: Record<CallbackStage, string> = {
  connected: "connected",
  token_exchange_failed: "error",
  missing_refresh_token: "error",
  identity_request_failed: "error",
  identity_scope_missing: "identity_scope_missing",
  identity_unavailable: "identity_unavailable",
  account_persist_failed: "persist_error",
  credential_persist_failed: "persist_error",
  state_consume_failed: "persist_error",
};

const at = (stage: CallbackStage, upstreamStatus?: number): StageOutcome => ({ stage, query: QUERY[stage], upstreamStatus });

/**
 * Ordered, verified callback resolution. State consumption is MANDATORY and
 * happens only after token exchange, identity, account, and credential all
 * succeed — and is confirmed. Any earlier failure returns a stage-specific
 * outcome and leaves the OAuth state UNCONSUMED (so a genuine retry can succeed).
 */
export async function resolveEbayCallback(deps: CallbackDeps): Promise<StageOutcome> {
  const ex = await deps.exchangeCode();
  if (!ex.ok || !ex.accessToken) return at("token_exchange_failed", ex.status);
  if (!ex.refreshToken) return at("missing_refresh_token");

  const id = await deps.fetchIdentity(ex.accessToken);
  if (!id.ok) return at(id.status === 403 ? "identity_scope_missing" : "identity_request_failed", id.status);
  if (!id.ebayUserId) return at("identity_unavailable");

  const acc = await deps.persistAccount(id.ebayUserId, ex.refreshTokenExpiresInSec ?? null);
  if (!acc.ok || !acc.accountId) return at("account_persist_failed");

  const cred = await deps.persistCredential(acc.accountId, ex.refreshToken, ex.scope ?? [], ex.refreshTokenExpiresInSec ?? null);
  if (!cred.ok) return at("credential_persist_failed");

  const consumed = await deps.consumeState();
  if (!consumed.ok) return at("state_consume_failed");
  if (!(await deps.confirmConsumed())) return at("state_consume_failed");

  return at("connected");
}
