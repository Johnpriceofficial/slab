/**
 * Pure, cross-runtime core for the admin-only `ebay-connect-status` Edge Function.
 *
 * Every security decision the function makes lives here so it is unit-tested
 * WITHOUT Deno (the index.ts shim injects real Supabase-backed dependencies):
 *   - admin-only access (unauthenticated -> 401, non-admin -> 403);
 *   - a strict ALLOWLIST of sanitized fields — never a token, refresh token,
 *     encrypted credential, client secret, OAuth code, raw OAuth state,
 *     service-role key, buyer PII, or financial payload;
 *   - truthful "not_connected" status when no account exists;
 *   - marketplace-mutation kill switches default OFF;
 *   - the canonical callback URL is the Supabase Edge Function (never an app route);
 *   - private credential data is reached ONLY through the injected service-role
 *     RPC loader, which returns scope metadata and never the token;
 *   - database errors fail closed: HTTP 503 with a safe code and no leak.
 */

import { EBAY_MUTATION_FLAGS, mutationEnabled } from "./ebay-mutation-flags.ts";

export const EBAY_CALLBACK_FUNCTION_PATH = "/functions/v1/ebay-oauth-callback";

/** The canonical eBay OAuth callback is always the Supabase Edge Function. */
export function ebayCallbackUrl(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}${EBAY_CALLBACK_FUNCTION_PATH}`;
}

export type EbayConnectionState =
  | "connected"
  | "not_connected"
  | "reauthorization_required"
  | "unavailable";

/** The ONLY keys a sanitized status body may contain. */
export const ALLOWLISTED_STATUS_KEYS = [
  "environment",
  "connectionState",
  "connected",
  "accountLabel",
  "ebayUserId",
  "marketplaceId",
  "connectedAt",
  "authorizationExpiresAt",
  "reauthorizationRequired",
  "requestedScopes",
  "grantedScopes",
  "scopeSource",
  "privilegeStatus",
  "lastSyncedAt",
  "inventoryLocationsCount",
  "businessPolicyCounts",
  "mutationFlags",
  "callbackUrl",
  "errorCode",
  "checkedAt",
] as const;

export interface EbayMutationFlagState {
  listing: boolean;
  fulfillment: boolean;
  financial: boolean;
  applySales: boolean;
}

export interface EbayBusinessPolicyCounts {
  fulfillment: number;
  payment: number;
  return: number;
}

export interface SanitizedConnectStatus {
  environment: string;
  connectionState: EbayConnectionState;
  connected: boolean;
  accountLabel: string | null;
  ebayUserId: string | null;
  marketplaceId: string | null;
  connectedAt: string | null;
  authorizationExpiresAt: string | null;
  reauthorizationRequired: boolean;
  requestedScopes: string[];
  grantedScopes: string[];
  scopeSource: string | null;
  privilegeStatus: string | null;
  lastSyncedAt: string | null;
  inventoryLocationsCount: number;
  businessPolicyCounts: EbayBusinessPolicyCounts;
  mutationFlags: EbayMutationFlagState;
  callbackUrl: string;
  errorCode: string | null;
  checkedAt: string;
}

/** Raw eBay account row. Unknown/extra fields are ignored by the sanitizer. */
export interface EbayAccountRow {
  id: string;
  ebay_user_id?: string | null;
  marketplace_id?: string | null;
  display_label?: string | null;
  connection_status?: string | null;
  privilege_status?: string | null;
  authorization_expires_at?: string | null;
  last_synced_at?: string | null;
  connected_at?: string | null;
  [key: string]: unknown;
}

/** Scope metadata from the service-role RPC. NEVER contains a token. */
export interface EbayScopeMeta {
  requestedScopes: string[];
  grantedScopes: string[];
  scopeSource: string | null;
}

export interface EbayResourceCounts {
  inventoryLocations: number;
  businessPolicies: EbayBusinessPolicyCounts;
}

export function buildMutationFlags(
  env: Record<string, string | undefined>,
): EbayMutationFlagState {
  return {
    listing: mutationEnabled(env[EBAY_MUTATION_FLAGS.listing]),
    fulfillment: mutationEnabled(env[EBAY_MUTATION_FLAGS.fulfillment]),
    financial: mutationEnabled(env[EBAY_MUTATION_FLAGS.financial]),
    applySales: mutationEnabled(env[EBAY_MUTATION_FLAGS.applySales]),
  };
}

function isExpired(iso: string | null | undefined, nowMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= nowMs;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function connectionStateFor(account: EbayAccountRow, nowMs: number): EbayConnectionState {
  const status = (account.connection_status ?? "").trim().toLowerCase();
  const connected = status === "connected" || status === "active";
  if (!connected) return "not_connected";
  return isExpired(account.authorization_expires_at, nowMs) ? "reauthorization_required" : "connected";
}

export interface BuildStatusInput {
  account: EbayAccountRow | null;
  scopeMeta: EbayScopeMeta | null;
  counts: EbayResourceCounts | null;
  mutationEnv: Record<string, string | undefined>;
  environment: string;
  supabaseUrl: string;
  now: string;
}

const EMPTY_POLICY_COUNTS: EbayBusinessPolicyCounts = { fulfillment: 0, payment: 0, return: 0 };

/**
 * Build the sanitized status. ONLY allowlisted keys are ever set here, so token
 * material present on the raw inputs is structurally excluded from the output.
 */
export function buildConnectStatus(input: BuildStatusInput): SanitizedConnectStatus {
  const nowMs = Date.parse(input.now);
  const flags = buildMutationFlags(input.mutationEnv);
  const callbackUrl = ebayCallbackUrl(input.supabaseUrl);

  if (!input.account) {
    return {
      environment: input.environment,
      connectionState: "not_connected",
      connected: false,
      accountLabel: null,
      ebayUserId: null,
      marketplaceId: null,
      connectedAt: null,
      authorizationExpiresAt: null,
      reauthorizationRequired: false,
      requestedScopes: [],
      grantedScopes: [],
      scopeSource: null,
      privilegeStatus: null,
      lastSyncedAt: null,
      inventoryLocationsCount: 0,
      businessPolicyCounts: { ...EMPTY_POLICY_COUNTS },
      mutationFlags: flags,
      callbackUrl,
      errorCode: null,
      checkedAt: input.now,
    };
  }

  const account = input.account;
  const state = connectionStateFor(account, Number.isFinite(nowMs) ? nowMs : 0);
  return {
    environment: input.environment,
    connectionState: state,
    connected: state === "connected",
    accountLabel: stringOrNull(account.display_label) ?? stringOrNull(account.ebay_user_id),
    ebayUserId: stringOrNull(account.ebay_user_id),
    marketplaceId: stringOrNull(account.marketplace_id),
    connectedAt: stringOrNull(account.connected_at),
    authorizationExpiresAt: stringOrNull(account.authorization_expires_at),
    reauthorizationRequired: state === "reauthorization_required",
    requestedScopes: input.scopeMeta?.requestedScopes ?? [],
    grantedScopes: input.scopeMeta?.grantedScopes ?? [],
    scopeSource: input.scopeMeta?.scopeSource ?? null,
    privilegeStatus: stringOrNull(account.privilege_status),
    lastSyncedAt: stringOrNull(account.last_synced_at),
    inventoryLocationsCount: input.counts?.inventoryLocations ?? 0,
    businessPolicyCounts: input.counts?.businessPolicies ?? { ...EMPTY_POLICY_COUNTS },
    mutationFlags: flags,
    callbackUrl,
    errorCode: null,
    checkedAt: input.now,
  };
}

/* ------------------------------------------------------------------ */
/* Defense-in-depth secret guard                                       */
/* ------------------------------------------------------------------ */

const SECRET_KEY_DENYLIST = new Set([
  "refresh_token",
  "refreshtoken",
  "access_token",
  "accesstoken",
  "refresh_token_encrypted",
  "token",
  "client_secret",
  "clientsecret",
  "secret",
  "encryption_key",
  "encryptionkey",
  "service_role_key",
  "servicerolekey",
  "service_key",
  "authorization_code",
  "oauth_code",
  "oauth_state",
  "state_hash",
  "statehash",
  "password",
  "apikey",
  "api_key",
]);

/** True when a string looks like token/secret material (JWT, PEM, long base64). */
export function isSecretShapedValue(value: string): boolean {
  const s = value.trim();
  if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/.test(s)) return true; // JWT
  if (/-----BEGIN[A-Z ]*PRIVATE KEY-----/.test(s)) return true; // PEM
  if (/^[A-Za-z0-9+/]{60,}={0,2}$/.test(s)) return true; // long, separator-free base64 (encrypted token)
  return false;
}

/** Throws if any denylisted key or secret-shaped value appears. */
export function assertNoSecretShapedFields(obj: unknown, path = "$"): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === "string") {
    if (isSecretShapedValue(obj)) throw new Error(`secret-shaped value at ${path}`);
    return;
  }
  if (typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertNoSecretShapedFields(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_KEY_DENYLIST.has(k.toLowerCase())) {
      throw new Error(`secret-shaped key "${k}" at ${path}`);
    }
    assertNoSecretShapedFields(v, `${path}.${k}`);
  }
}

/* ------------------------------------------------------------------ */
/* Request handler (dependency-injected, cross-runtime)                */
/* ------------------------------------------------------------------ */

export interface ConnectStatusDeps {
  /** Verify the caller. Returns the user (or null) and whether they are admin. */
  checkAdmin: (req: Request) => Promise<{ user: { id: string } | null; isAdmin: boolean }>;
  /** Load the single eBay account row, or null when disconnected. Service role. */
  loadAccount: () => Promise<EbayAccountRow | null>;
  /** Load scope metadata via the service-role RPC ONLY. Never returns a token. */
  loadScopeMeta: (accountId: string) => Promise<EbayScopeMeta>;
  /** Load resource counts (locations, business policies). */
  loadCounts: (accountId: string) => Promise<EbayResourceCounts>;
  mutationEnv: Record<string, string | undefined>;
  environment: string;
  supabaseUrl: string;
  now: () => string;
  corsHeaders?: Record<string, string>;
}

function jsonResponse(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

/**
 * The admin-only connect-status handler. Fails closed on every error path and
 * never emits token material.
 */
export async function handleConnectStatus(req: Request, deps: ConnectStatusDeps): Promise<Response> {
  const cors = deps.corsHeaders ?? {};

  const { user, isAdmin } = await deps.checkAdmin(req);
  if (!user) return jsonResponse(401, { error: "Unauthorized" }, cors);
  if (!isAdmin) return jsonResponse(403, { error: "Forbidden" }, cors);

  try {
    const account = await deps.loadAccount();
    let scopeMeta: EbayScopeMeta | null = null;
    let counts: EbayResourceCounts | null = null;
    if (account) {
      // Private credential data is reached ONLY through the service-role RPC.
      scopeMeta = await deps.loadScopeMeta(account.id);
      counts = await deps.loadCounts(account.id);
    }

    const status = buildConnectStatus({
      account,
      scopeMeta,
      counts,
      mutationEnv: deps.mutationEnv,
      environment: deps.environment,
      supabaseUrl: deps.supabaseUrl,
      now: deps.now(),
    });

    // Belt-and-suspenders: refuse to emit anything secret-shaped.
    assertNoSecretShapedFields(status);
    return jsonResponse(200, status, cors);
  } catch {
    // Fail closed: no error detail is leaked and no connection is claimed.
    return jsonResponse(
      503,
      { error: "status_unavailable", errorCode: "status_unavailable", connected: false },
      cors,
    );
  }
}
