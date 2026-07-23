import { createClient } from "npm:@supabase/supabase-js@2.110.2";
import { corsHeaders } from "./cors.ts";
import { isCallerAdmin, unauthorizedResponse } from "./auth.ts";
import { EBAY_OAUTH_SCOPES, ebayApizBase, refreshScopeParam } from "./ebay-oauth-core.ts";
import { persistRotatedRefreshToken } from "./ebay-credential-rotation.ts";
import { classifyOAuthRefreshFailure, type OAuthRefreshClassification } from "./ebay-oauth-refresh-classifier.ts";

const MODE = Deno.env.get("EBAY_ENVIRONMENT") === "sandbox" ? "sandbox" : "production";
const API = MODE === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
const CLIENT_ID = Deno.env.get("EBAY_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("EBAY_CLIENT_SECRET") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY);
}
type Admin = ReturnType<typeof adminClient>;

function reply(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
async function encryptionKey(): Promise<CryptoKey> {
  const raw = Deno.env.get("EBAY_TOKEN_ENCRYPTION_KEY") ?? "";
  const bytes = base64ToBytes(raw);
  if (![16, 24, 32].includes(bytes.length)) throw new Error("oauth_configuration_error");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function decryptToken(value: string): Promise<string> {
  const bytes = base64ToBytes(value);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await encryptionKey(), bytes.slice(12));
  return new TextDecoder().decode(clear);
}
async function encryptToken(token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(), new TextEncoder().encode(token)));
  const joined = new Uint8Array(iv.length + encrypted.length);
  joined.set(iv); joined.set(encrypted, iv.length);
  return bytesToBase64(joined);
}

interface TokenSuccess { ok: true; token: string }
interface TokenFailure { ok: false; failure: OAuthRefreshClassification }
type TokenResult = TokenSuccess | TokenFailure;

async function loadAccessToken(admin: Admin, accountId: string): Promise<TokenResult> {
  if (!CLIENT_ID || !CLIENT_SECRET || !SUPABASE_URL || !SERVICE_KEY || !Deno.env.get("EBAY_TOKEN_ENCRYPTION_KEY")) {
    return { ok: false, failure: classifyOAuthRefreshFailure({ configurationError: true }) };
  }
  const { data: credential, error: credentialError } = await admin.rpc("ebay_oauth_credential_get", { p_account_id: accountId }).maybeSingle();
  if (credentialError) return { ok: false, failure: classifyOAuthRefreshFailure({ persistenceError: true }) };
  if (!credential) return { ok: false, failure: classifyOAuthRefreshFailure({ missingCredential: true }) };

  let refreshToken: string;
  try {
    refreshToken = await decryptToken(String(credential.refresh_token_encrypted ?? ""));
  } catch {
    return { ok: false, failure: classifyOAuthRefreshFailure({ configurationError: true }) };
  }

  let response: Response;
  try {
    const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
    params.set("scope", refreshScopeParam(credential.requested_scopes as string[] | undefined, EBAY_OAUTH_SCOPES));
    response = await fetch(`${API}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
  } catch {
    return { ok: false, failure: classifyOAuthRefreshFailure({ networkError: true }) };
  }

  const parsed = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const providerError = parsed && typeof parsed.error === "string" ? parsed.error : null;
    return { ok: false, failure: classifyOAuthRefreshFailure({ httpStatus: response.status, providerError }) };
  }
  if (!parsed || typeof parsed.access_token !== "string" || !parsed.access_token) {
    return { ok: false, failure: classifyOAuthRefreshFailure({ httpStatus: response.status, invalidResponse: true }) };
  }

  const priorEncrypted = String(credential.refresh_token_encrypted ?? "");
  const rotation = await persistRotatedRefreshToken({
    accountId,
    priorEncrypted,
    newRefreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : null,
    refreshTokenExpiresInSec: parsed.refresh_token_expires_in ? Number(parsed.refresh_token_expires_in) : null,
    scopes: typeof parsed.scope === "string" ? parsed.scope.split(" ") : null,
    encrypt: encryptToken,
    update: async (patch, where) => {
      const { data, error } = await admin.rpc("ebay_oauth_credential_rotate", {
        p_account_id: where.accountId,
        p_prior_encrypted: where.priorEncrypted,
        p_new_encrypted: patch.refresh_token_encrypted,
        p_refresh_token_expires_at: patch.refresh_token_expires_at ?? null,
        p_scopes: patch.scopes ?? null,
        p_rotated_at: patch.rotated_at,
      });
      return { error, rowCount: typeof data === "number" ? data : 0 };
    },
  });
  if (rotation.outcome === "persist_failed") return { ok: false, failure: classifyOAuthRefreshFailure({ persistenceError: true }) };
  return { ok: true, token: parsed.access_token };
}

interface ProviderResult { ok: boolean; status: number; data: Record<string, unknown>; latency: number }
async function providerGet(path: string, token: string): Promise<ProviderResult> {
  const started = Date.now();
  try {
    const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Language": "en-US" } });
    return { ok: response.ok, status: response.status, data: await response.json().catch(() => ({})) as Record<string, unknown>, latency: Date.now() - started };
  } catch {
    return { ok: false, status: 0, data: {}, latency: Date.now() - started };
  }
}

export async function handleEbayAccountSyncV2(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const correlationId = crypto.randomUUID();
  const auth = await isCallerAdmin(req);
  if (!auth.user || !auth.isAdmin) return unauthorizedResponse(corsHeaders);
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const accountId = String(body.account_id ?? "");
  if (!accountId) return reply({ status: "error", error_code: "MISSING_ACCOUNT", correlation_id: correlationId, message: "account_id is required." }, 400);
  const marketplaceId = String(body.marketplace_id ?? "EBAY_US");
  const admin = adminClient();
  const startedAt = Date.now();

  const token = await loadAccessToken(admin, accountId);
  if (!token.ok) {
    const failure = token.failure;
    if (failure.reconnectRequired) {
      await admin.from("ebay_accounts").update({ connection_status: "reauthorization_required" }).eq("id", accountId);
    }
    await admin.rpc("ebay_api_run_record", {
      p_account_id: accountId, p_operation: "account_sync", p_status: "error",
      p_http_status: failure.httpStatus, p_request_id: correlationId,
      p_latency_ms: Date.now() - startedAt, p_error_code: failure.errorCode,
    });
    return reply({
      status: failure.status,
      error_code: failure.errorCode,
      retryable: failure.retryable,
      reconnect_required: failure.reconnectRequired,
      correlation_id: correlationId,
      message: failure.message,
    }, failure.httpStatus);
  }

  const record = async (operation: string, status: string, http: number | null, latency: number, errorCode: string | null) => {
    return admin.rpc("ebay_api_run_record", {
      p_account_id: accountId, p_operation: operation, p_status: status,
      p_http_status: http, p_request_id: correlationId,
      p_latency_ms: Math.max(0, Math.round(latency)), p_error_code: errorCode,
    });
  };

  const identityStarted = Date.now();
  let identityOk = false;
  let opaqueUserId: string | null = null;
  let identityStatus = 0;
  try {
    const response = await fetch(`${ebayApizBase(MODE)}/commerce/identity/v1/user/`, { headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" } });
    identityStatus = response.status;
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    opaqueUserId = response.ok && typeof data.userId === "string" && data.userId ? data.userId : null;
    identityOk = Boolean(opaqueUserId);
  } catch { identityStatus = 0; }
  await record("account_identity", identityOk ? "success" : "error", identityStatus || null, Date.now() - identityStarted, identityOk ? null : "identity_request_failed");

  const [priv, loc, ful, pay, ret] = await Promise.all([
    providerGet("/sell/account/v1/privilege", token.token),
    providerGet("/sell/inventory/v1/location?limit=100", token.token),
    providerGet(`/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`, token.token),
    providerGet(`/sell/account/v1/payment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`, token.token),
    providerGet(`/sell/account/v1/return_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`, token.token),
  ]);
  await record("account_privileges", priv.ok ? "success" : "error", priv.status || null, priv.latency, priv.ok ? null : "privilege_fetch_failed");
  await record("inventory_locations_fetch", loc.ok ? "success" : "error", loc.status || null, loc.latency, loc.ok ? null : "locations_fetch_failed");
  await record("fulfillment_policies_fetch", ful.ok ? "success" : "error", ful.status || null, ful.latency, ful.ok ? null : "fulfillment_policy_fetch_failed");
  await record("payment_policies_fetch", pay.ok ? "success" : "error", pay.status || null, pay.latency, pay.ok ? null : "payment_policy_fetch_failed");
  await record("return_policies_fetch", ret.ok ? "success" : "error", ret.status || null, ret.latency, ret.ok ? null : "return_policy_fetch_failed");

  let persistenceError: string | null = null;
  let locationCount: number | null = null;
  // Replace only after a complete successful location response. A failed read does
  // not call the replace RPC, so the last-known-good snapshot remains intact.
  if (loc.ok) {
    const rows = (Array.isArray(loc.data.locations) ? loc.data.locations as Record<string, unknown>[] : [])
      .map((item) => ({ merchant_location_key: String(item.merchantLocationKey ?? ""), status: typeof item.merchantLocationStatus === "string" ? item.merchantLocationStatus : null, raw_enum_value: item.locationTypes != null ? JSON.stringify(item.locationTypes) : null }))
      .filter((item) => item.merchant_location_key);
    const result = await admin.rpc("ebay_inventory_locations_replace", { p_account_id: accountId, p_locations: rows });
    if (result.error) persistenceError = "locations_persist_failed";
    else locationCount = typeof result.data === "number" ? result.data : null;
    await record("inventory_locations_persistence", result.error ? "error" : "success", null, 0, result.error ? "locations_persist_failed" : null);
  }

  const policyRows: Record<string, unknown>[] = [];
  const collect = (result: ProviderResult, key: string, idField: string, type: string) => {
    if (!result.ok) return false;
    for (const item of (Array.isArray(result.data[key]) ? result.data[key] as Record<string, unknown>[] : [])) {
      const policyId = String(item[idField] ?? "");
      if (policyId) policyRows.push({ policy_id: policyId, policy_type: type, name: typeof item.name === "string" ? item.name : null, marketplace_id: typeof item.marketplaceId === "string" ? item.marketplaceId : marketplaceId });
    }
    return true;
  };
  const fOk = collect(ful, "fulfillmentPolicies", "fulfillmentPolicyId", "fulfillment");
  const pOk = collect(pay, "paymentPolicies", "paymentPolicyId", "payment");
  const rOk = collect(ret, "returnPolicies", "returnPolicyId", "return");
  const allPoliciesFetched = fOk && pOk && rOk;
  let policyCounts: { fulfillment: number; payment: number; return: number } | null = null;
  // Atomic group replacement only after all three reads succeed. Any failed group
  // leaves every last-known-good policy row untouched.
  if (allPoliciesFetched && !persistenceError) {
    const result = await admin.rpc("ebay_business_policies_replace", { p_account_id: accountId, p_policies: policyRows });
    if (result.error) persistenceError = "policies_persist_failed";
    else policyCounts = result.data as typeof policyCounts;
    await record("business_policies_persistence", result.error ? "error" : "success", null, 0, result.error ? "policies_persist_failed" : null);
  }

  const privilegeStatus = priv.ok ? "verified" : "unverified";
  const accountUpdate = await admin.from("ebay_accounts").update({ connection_status: "connected", privilege_status: privilegeStatus }).eq("id", accountId);
  if (accountUpdate.error) persistenceError = persistenceError ?? "account_update_failed";

  const resources = {
    identity: { status: identityOk ? "success" : "error", http: identityStatus || null, count: null, error_code: identityOk ? null : "identity_request_failed" },
    privileges: { status: priv.ok ? "success" : "error", http: priv.status || null, count: null, error_code: priv.ok ? null : "privilege_fetch_failed" },
    locations: { status: loc.ok && !persistenceError ? "success" : "error", http: loc.status || null, count: locationCount, error_code: loc.ok ? (persistenceError === "locations_persist_failed" ? persistenceError : null) : "locations_fetch_failed" },
    fulfillment_policies: { status: allPoliciesFetched && policyCounts ? "success" : "error", http: ful.status || null, count: policyCounts?.fulfillment ?? null, error_code: fOk ? (allPoliciesFetched ? (persistenceError === "policies_persist_failed" ? persistenceError : null) : "policy_group_incomplete") : "fulfillment_policy_fetch_failed" },
    payment_policies: { status: allPoliciesFetched && policyCounts ? "success" : "error", http: pay.status || null, count: policyCounts?.payment ?? null, error_code: pOk ? (allPoliciesFetched ? (persistenceError === "policies_persist_failed" ? persistenceError : null) : "policy_group_incomplete") : "payment_policy_fetch_failed" },
    return_policies: { status: allPoliciesFetched && policyCounts ? "success" : "error", http: ret.status || null, count: policyCounts?.return ?? null, error_code: rOk ? (allPoliciesFetched ? (persistenceError === "policies_persist_failed" ? persistenceError : null) : "policy_group_incomplete") : "return_policy_fetch_failed" },
  };

  const discoveryComplete = identityOk && priv.ok && loc.ok && allPoliciesFetched && !persistenceError && locationCount !== null && policyCounts !== null;
  const discoveredCount = (locationCount ?? 0) + (policyCounts?.fulfillment ?? 0) + (policyCounts?.payment ?? 0) + (policyCounts?.return ?? 0);
  await admin.rpc("ebay_sync_cursor_touch", { p_account_id: accountId, p_resource_type: "account_discovery_attempt", p_count: discoveredCount });
  if (discoveryComplete) await admin.rpc("ebay_sync_cursor_touch", { p_account_id: accountId, p_resource_type: "account_discovery_complete", p_count: discoveredCount });

  if (persistenceError) {
    await record("account_sync", "error", null, Date.now() - startedAt, persistenceError);
    return reply({ status: "error", error_code: persistenceError, retryable: true, reconnect_required: false, correlation_id: correlationId, resources, message: "eBay discovery could not be saved. Last-known-good locations and policies were preserved." }, 500);
  }

  const status = discoveryComplete ? "success" : "partial";
  await record("account_sync", status, null, Date.now() - startedAt, discoveryComplete ? null : "partial_discovery");
  return reply({
    status,
    account_id: accountId,
    opaque_user_id: opaqueUserId,
    privilege_status: privilegeStatus,
    retryable: !discoveryComplete,
    reconnect_required: false,
    correlation_id: correlationId,
    snapshots_preserved: !discoveryComplete,
    resources,
    message: discoveryComplete
      ? "eBay account discovery completed."
      : "Some eBay requirements were unavailable. Last-known-good locations and policies were preserved, and publishing remains blocked until a complete refresh succeeds.",
  });
}
