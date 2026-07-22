import { createClient } from "npm:@supabase/supabase-js@2.110.2";
import { corsHeaders } from "./cors.ts";
import { isCallerAdmin, unauthorizedResponse } from "./auth.ts";
import { getEbayAppToken } from "./ebay-app-token.ts";
import {
  createPublicKeyCache,
  processEbayNotification,
  type EbayPublicKey,
} from "./ebay-notification-verify.ts";
import { persistRotatedRefreshToken } from "./ebay-credential-rotation.ts";
import { EBAY_OAUTH_SCOPES, buildAuthorizeQuery, ebayApizBase, refreshScopeParam, resolveEbayCallback, resolveScopePersistence } from "./ebay-oauth-core.ts";
import { shapeEbayFinanceTransactions, shapeEbayOrders, skusFromOrders } from "./ebay-orders-core.ts";
import { canonicalSkuFromInventoryNumber, hasFrontImage, listingFingerprint, orderedImagePaths, resolveExistingOffers, resolvePublishAction } from "./ebay-listing-core.ts";
import { fetchAllOffersForSku, OFFER_MAX_PAGES, type OffersDiscovery } from "./ebay-offers.ts";
import { EBAY_MUTATION_FLAGS, mutationEnabled } from "./ebay-mutation-flags.ts";

type Operation =
  | "oauth_start" | "oauth_callback" | "account_sync" | "reference_search"
  | "list_item" | "revise_item" | "end_item" | "order_sync"
  | "fulfillment" | "finances_sync" | "notification";

const MODE = Deno.env.get("EBAY_ENVIRONMENT") === "sandbox" ? "sandbox" : "production";
const API = MODE === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
const AUTH = MODE === "sandbox" ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com";
const CLIENT_ID = Deno.env.get("EBAY_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("EBAY_CLIENT_SECRET") ?? "";
const REDIRECT_URI = Deno.env.get("EBAY_REDIRECT_URI") ?? "";
const RU_NAME = Deno.env.get("EBAY_RU_NAME") ?? Deno.env.get("EBAY_RUNAME") ?? "";
// Where the browser lands after the eBay OAuth hop. A same-app relative path from
// the stored state is honored; anything else falls back here (open-redirect guard).
const APP_BASE = (Deno.env.get("EBAY_APP_BASE_URL") ?? "https://gradedcardvalue.com").replace(/\/+$/, "");

// Server-only marketplace-mutation kill switches. All default OFF — a mutation is
// possible ONLY when its flag is explicitly "true" in the function's environment.
// The browser cannot set these and a confirmation phrase cannot bypass them.
// Read-only discovery, listing preparation, and inbound order/finance sync are
// never gated by these; only outward/destructive mutations are.
function flagEnabled(name: string): boolean {
  return mutationEnabled(Deno.env.get(name));
}
const MUTATION_FLAGS = EBAY_MUTATION_FLAGS;

// One factory + concrete type for the service-role admin client. Annotating the
// admin as ReturnType<typeof createClient> (the default, never-schema generic)
// mistypes every .rpc()/.from() result; deriving the type from an actual call
// keeps rows/RPC returns properly typed.
function makeAdmin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}
type AdminClient = ReturnType<typeof makeAdmin>;

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Stable, non-sensitive response when a mutation is disabled by server config.
// Never names the flag value; just states the class of mutation that is off.
function mutationDisabled(operation: string, kind: string): Response {
  return reply({ status: "mutation_disabled", operation, kind, message: `eBay ${kind} mutations are disabled by server configuration.` }, 403);
}

// Record an api-run and report whether the observability write itself persisted.
// A false return means the audit row was lost — a durability failure the caller
// must surface, never silently swallow.
async function recordApiRun(admin: AdminClient, accountId: string, operation: string, status: string, latencyMs: number, errorCode: string | null): Promise<boolean> {
  const { error } = await admin.rpc("ebay_api_run_record", { p_account_id: accountId, p_operation: operation, p_status: status, p_http_status: null, p_request_id: null, p_latency_ms: Math.max(0, Math.round(latencyMs)), p_error_code: errorCode });
  return !error;
}

// Browser-facing 302 back into the app after the OAuth hop. `status` surfaces the
// outcome (connected / denied / invalid_state / …) so the UI can react. Only a
// same-app relative path is accepted, to block open redirects.
function appRedirect(pathAfter: unknown, status: string): Response {
  const path = typeof pathAfter === "string" && pathAfter.startsWith("/") && !pathAfter.startsWith("//") ? pathAfter : "/slabs";
  const sep = path.includes("?") ? "&" : "?";
  return new Response(null, { status: 302, headers: { ...corsHeaders, Location: `${APP_BASE}${path}${sep}ebay=${encodeURIComponent(status)}` } });
}

function safeEnum(value: unknown): { raw: string | null; label: string } {
  if (value === null || value === undefined) return { raw: null, label: "Unknown" };
  const raw = String(value);
  return { raw, label: raw.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) || "Unknown" };
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function encryptionKey(): Promise<CryptoKey> {
  const raw = Deno.env.get("EBAY_TOKEN_ENCRYPTION_KEY") ?? "";
  const bytes = base64ToBytes(raw);
  if (![16, 24, 32].includes(bytes.length)) throw new Error("eBay token encryption is not configured.");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptToken(token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(), new TextEncoder().encode(token)));
  const joined = new Uint8Array(iv.length + encrypted.length);
  joined.set(iv); joined.set(encrypted, iv.length);
  return bytesToBase64(joined);
}

async function decryptToken(value: string): Promise<string> {
  const bytes = base64ToBytes(value);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await encryptionKey(), bytes.slice(12));
  return new TextDecoder().decode(clear);
}

function configured(): boolean {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

async function oauthToken(params: URLSearchParams): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  if (!res.ok) throw new Error(`eBay OAuth returned HTTP ${res.status}.`);
  return await res.json();
}

// Public Browse app token: reuse the shared client-credentials flow so there is
// ONE application-token implementation across the eBay functions.
function appToken(): Promise<string> {
  return getEbayAppToken();
}

async function ebayFetchBase(base: string, path: string, token: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Language": "en-US",
      ...(init.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`eBay API returned HTTP ${res.status}.`);
  return data as Record<string, unknown>;
}

// Most Sell/Browse/Taxonomy calls live on the main api.* host; the Finances and
// Identity APIs live on the apiz gateway (see ebayApizBase / order+finance sync).
function ebayFetch(path: string, token: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  return ebayFetchBase(API, path, token, init);
}

// The shared, PAGINATED, FAIL-CLOSED getOffers discovery lives in ebay-offers.ts
// (dependency-injected for testing). This thin wrapper binds the real fetch, the
// approved API origin, and the server page cap.
function discoverOffers(accessToken: string, sku: string): Promise<OffersDiscovery> {
  return fetchAllOffersForSku({
    fetchImpl: (url, init) => fetch(url, init),
    apiOrigin: new URL(API).origin,
    accessToken,
    sku,
    maxPages: OFFER_MAX_PAGES,
  });
}

// Fence a long publish: prove THIS caller still holds its lease and extend it.
// A false return means the lease was lost/superseded — abort before any mutation.
async function assertLeaseHeld(admin: AdminClient, accountId: string, sku: string, token: string): Promise<boolean> {
  const { data, error } = await admin.rpc("ebay_publish_lease_assert_and_extend", { p_account_id: accountId, p_sku: sku, p_token: token, p_ttl_seconds: 120 });
  if (error) return false;
  return (data as { held?: boolean } | null)?.held === true;
}

// Cached eBay getPublicKey lookups (≈1h TTL) used to verify notification
// signatures. Uses the server-side application token; the key is public.
const publicKeyCache = createPublicKeyCache();
async function fetchEbayPublicKey(kid: string): Promise<EbayPublicKey> {
  const data = await ebayFetch(`/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`, await appToken());
  return {
    algorithm: typeof data.algorithm === "string" ? data.algorithm : "ECDSA",
    digest: typeof data.digest === "string" ? data.digest : undefined,
    key: typeof data.key === "string" ? data.key : "",
  };
}

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  try { return await req.json(); } catch { return {}; }
}

async function requireAdmin(req: Request) {
  const auth = await isCallerAdmin(req);
  if (!auth.user) return { error: unauthorizedResponse(corsHeaders), user: null };
  if (!auth.isAdmin) return { error: reply({ status: "error", error_code: "NOT_AUTHORIZED", message: "Admin access required." }, 403), user: null };
  return { error: null, user: auth.user };
}

function confirmation(body: Record<string, unknown>, phrase: string): Response | null {
  if (body.confirmation === phrase) return null;
  return reply({
    status: "confirmation_required",
    confirmation_phrase: phrase,
    message: `Review the marketplace payload and explicitly confirm ${phrase} before this external mutation runs.`,
  }, 409);
}

async function userAccessToken(admin: AdminClient, accountId: string): Promise<string> {
  // Private-schema reads/writes go through SECURITY DEFINER RPCs (service_role
  // only); the `private` schema is intentionally not exposed to the Data API.
  const { data: credential } = await admin
    .rpc("ebay_oauth_credential_get", { p_account_id: accountId }).maybeSingle();
  if (!credential) throw new Error("CONNECTED_ACCOUNT_REQUIRED");
  const priorEncrypted = credential.refresh_token_encrypted as string;
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: await decryptToken(priorEncrypted),
  });
  // Always refresh with the canonical scope set — never drop granted scopes.
  params.set("scope", refreshScopeParam(credential.requested_scopes as string[] | undefined, EBAY_OAUTH_SCOPES));
  const refreshed = await oauthToken(params);
  if (typeof refreshed.access_token !== "string") throw new Error("OAUTH_REFRESH_FAILED");
  // eBay MAY return a rotated refresh token. Persist it with optimistic
  // concurrency (write conditioned on the ciphertext we refreshed from) and
  // VERIFY the write: a failed persist means the stored credential is now stale,
  // so mark the account for reauthorization and fail rather than report a false
  // success. No token value is ever logged or returned.
  const rotation = await persistRotatedRefreshToken({
    accountId,
    priorEncrypted,
    newRefreshToken: typeof refreshed.refresh_token === "string" ? refreshed.refresh_token : null,
    refreshTokenExpiresInSec: refreshed.refresh_token_expires_in ? Number(refreshed.refresh_token_expires_in) : null,
    scopes: typeof refreshed.scope === "string" ? refreshed.scope.split(" ") : null,
    encrypt: encryptToken,
    update: async (patch, where) => {
      // The RPC applies the optimistic-concurrency guard (prior ciphertext) in
      // SQL and returns the row count; 0 => a concurrent rotation won.
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
  if (rotation.outcome === "persist_failed") {
    // Best-effort flag so the UI surfaces a reconnect; the throw stops any caller
    // from proceeding on a credential we know is now stale.
    await admin.from("ebay_accounts").update({ connection_status: "reauthorization_required" }).eq("id", accountId);
    throw new Error("REFRESH_TOKEN_ROTATION_PERSIST_FAILED");
  }
  return refreshed.access_token;
}

function unavailable(operation: Operation, capability: string): Response {
  return reply({
    status: "unavailable",
    operation,
    capability,
    message: "eBay is not connected or this seller/application is not eligible for the required API capability.",
    required_configuration: ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_RU_NAME", "EBAY_REDIRECT_URI", "EBAY_TOKEN_ENCRYPTION_KEY"],
  }, 409);
}

export async function handleEbay(req: Request, operation: Operation): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!configured()) return unavailable(operation, operation === "reference_search" ? "Browse API" : "Seller API");

  if (operation === "notification" && req.method === "GET") {
    const url = new URL(req.url);
    const challenge = url.searchParams.get("challenge_code") ?? "";
    const token = Deno.env.get("EBAY_NOTIFICATION_VERIFICATION_TOKEN") ?? "";
    const endpoint = Deno.env.get("EBAY_NOTIFICATION_ENDPOINT") ?? "";
    if (!challenge || !token || !endpoint) return reply({ status: "error", message: "Notification verification is not configured." }, 503);
    return reply({ challengeResponse: await sha256(challenge + token + endpoint) });
  }
  if (operation === "notification") {
    // Verify eBay's signature over the RAW body, then durably persist to the
    // replay-safe inbox BEFORE acknowledging. A persistence failure returns a
    // retryable 503 (never a false 200) — see processEbayNotification.
    const rawBody = await req.text();
    const admin = makeAdmin();
    const decision = await processEbayNotification({
      rawBody,
      signatureHeader: req.headers.get("x-ebay-signature"),
      getPublicKey: (kid) => publicKeyCache.get(kid, fetchEbayPublicKey),
      persist: async (record) => {
        // Supabase resolves with `{ error }` on failure; upsert w/ ignoreDuplicates
        // makes a replayed notification a no-op success (replay-safe idempotency).
        const { error } = await admin.from("ebay_notifications").upsert(
          { notification_id: record.notification_id, topic: record.topic, status: "received", payload_sha256: record.payload_sha256 },
          { onConflict: "notification_id", ignoreDuplicates: true },
        );
        return { error };
      },
    });
    return reply(decision.body, decision.status);
  }

  if (operation === "oauth_callback") {
    // eBay redirects the BROWSER here, so every outcome is a 302 back into the app
    // with an `?ebay=<status>` marker the UI reads — never a raw JSON page.
    const url = new URL(req.url);
    if (url.searchParams.get("error")) return appRedirect(null, "denied"); // user declined consent
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    if (!state || !code || !RU_NAME) return appRedirect(null, "invalid_callback");
    const admin = makeAdmin();
    const stateHash = await sha256(state);
    const { data: stored } = await admin.rpc("ebay_oauth_state_get", { p_state_hash: stateHash }).maybeSingle();
    // Single-use + unexpired: a replayed or stale callback is rejected here.
    if (!stored || stored.consumed_at || new Date(stored.expires_at) <= new Date()) return appRedirect(null, "invalid_state");
    if (!Deno.env.get("EBAY_TOKEN_ENCRYPTION_KEY")) return appRedirect(null, "config_error");
    // Ordered, stage-specific resolution (see ebay-oauth-core.resolveEbayCallback):
    // state consumption is mandatory + verified and happens ONLY after token
    // exchange, identity, account, and credential all succeed — any earlier
    // failure leaves the state unconsumed so a genuine retry can succeed.
    const outcome = await resolveEbayCallback({
      exchangeCode: async () => {
        const res = await fetch(`${API}/identity/v1/oauth2/token`, {
          method: "POST",
          headers: { Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: RU_NAME }),
        });
        if (!res.ok) return { ok: false, status: res.status };
        const data = await res.json().catch(() => ({})) as Record<string, unknown>;
        const accessToken = typeof data.access_token === "string" ? data.access_token : "";
        return {
          ok: Boolean(accessToken), status: res.status, accessToken,
          refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : "",
          scope: typeof data.scope === "string" ? data.scope.split(" ") : [],
          refreshTokenExpiresInSec: data.refresh_token_expires_in ? Number(data.refresh_token_expires_in) : null,
        };
      },
      fetchIdentity: async (accessToken) => {
        // getUser lives on the apiz gateway — api.* returns 404 for this endpoint.
        const res = await fetch(`${ebayApizBase(MODE)}/commerce/identity/v1/user/`, { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } });
        if (!res.ok) return { ok: false, status: res.status };
        const data = await res.json().catch(() => ({})) as Record<string, unknown>;
        return { ok: true, ebayUserId: String(data.userId ?? data.username ?? "") };
      },
      persistAccount: async (ebayUserId, expSec) => {
        // connected_at marks the connection — NOT a completed sync (see account-sync).
        const { data, error } = await admin.from("ebay_accounts").upsert({
          ebay_user_id: ebayUserId, display_label: "Connected eBay seller", connection_status: "connected",
          authorization_expires_at: expSec ? new Date(Date.now() + expSec * 1000).toISOString() : null,
          connected_at: new Date().toISOString(),
        }, { onConflict: "ebay_user_id" }).select("id").single();
        return { ok: !error && !!data, accountId: (data as { id?: string } | null)?.id };
      },
      persistCredential: async (accountId, refreshToken, scope, expSec) => {
        const up = await admin.rpc("ebay_oauth_credential_upsert", {
          p_account_id: accountId, p_refresh_token_encrypted: await encryptToken(refreshToken),
          p_refresh_token_expires_at: expSec ? new Date(Date.now() + expSec * 1000).toISOString() : null,
          p_scopes: scope, p_rotated_at: new Date().toISOString(),
        });
        if (up.error) return { ok: false, stage: "credential_persist_failed" };
        // Honest provenance — and its persistence is REQUIRED, not best-effort.
        const prov = resolveScopePersistence(EBAY_OAUTH_SCOPES, scope);
        const set = await admin.rpc("ebay_credential_scopes_set", {
          p_account_id: accountId, p_requested_scopes: prov.requested_scopes,
          p_token_reported_scopes: prov.token_reported_scopes, p_scope_source: prov.scope_source,
        });
        if (set.error) return { ok: false, stage: "scope_persist_failed" };
        // Read-after-write: confirm the provenance landed before we ack the connect.
        const { data: check } = await admin.rpc("ebay_credential_scopes_get", { p_account_id: accountId }).maybeSingle();
        if ((check as { scope_source?: string } | null)?.scope_source !== prov.scope_source) return { ok: false, stage: "scope_persist_failed" };
        return { ok: true };
      },
      consumeState: async () => {
        const { error } = await admin.rpc("ebay_oauth_state_consume", { p_state_hash: stateHash });
        return { ok: !error };
      },
      confirmConsumed: async () => {
        const { data } = await admin.rpc("ebay_oauth_state_get", { p_state_hash: stateHash }).maybeSingle();
        return Boolean((data as { consumed_at?: string } | null)?.consumed_at);
      },
    });
    if (outcome.stage !== "connected") {
      // Safe diagnostic only — never tokens, code, raw state, secrets, or PII.
      console.error(JSON.stringify({
        operation: "ebay_oauth_callback", environment: MODE, callback_stage: outcome.stage,
        upstream_http_status: outcome.upstreamStatus ?? null, internal_error_code: outcome.stage,
        function_version: Deno.env.get("DENO_DEPLOYMENT_ID") ?? "unknown", at: new Date().toISOString(),
      }));
    }
    return appRedirect(outcome.stage === "connected" ? stored.redirect_after : null, outcome.query);
  }

  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const body = await parseBody(req);

  if (operation === "oauth_start") {
    if (!RU_NAME || !REDIRECT_URI) return unavailable(operation, "OAuth authorization-code flow");
    const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const admin = makeAdmin();
    // Single-flight: atomically expire this admin's prior unconsumed states and
    // create exactly one, under an advisory lock scoped to the requester.
    const { error: stateError } = await admin.rpc("ebay_oauth_state_create_single_flight", {
      p_state_hash: await sha256(state),
      p_requested_by: auth.user!.id,
      p_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      p_redirect_after: body.redirect_after ?? null,
    });
    // Without a persisted state the callback can never validate — fail loudly
    // instead of handing the user an authorization URL that will always reject.
    if (stateError) return reply({ status: "error", error_code: "STATE_PERSISTENCE_FAILED", message: "Could not initialize the eBay authorization request." }, 500);
    // Scopes include the BASE api_scope (required by the Identity API used in the
    // callback) plus the four seller scopes; sandbox adds prompt=login.
    const url = `${AUTH}/oauth2/authorize?${buildAuthorizeQuery({ clientId: CLIENT_ID, ruName: RU_NAME, state, mode: MODE })}`;
    return reply({ status: "success", authorization_url: url, expires_in_seconds: 600 });
  }

  if (operation === "reference_search") {
    const query = String(body.query ?? "").trim();
    if (!query) return reply({ status: "error", error_code: "MISSING_QUERY", message: "A reference search query is required." }, 400);
    const token = await appToken();
    const params = new URLSearchParams({ q: query, limit: "10" });
    const data = await ebayFetch(`/buy/browse/v1/item_summary/search?${params}`, token, { headers: { "X-EBAY-C-MARKETPLACE-ID": String(body.marketplace_id ?? "EBAY_US") } });
    const normalize = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const cardName = normalize(body.card_name);
    const collector = normalize(String(body.card_number ?? "").split("/")[0]).replace(/^0+/, "");
    const items = (Array.isArray(data.itemSummaries) ? data.itemSummaries : []).filter((raw: any) => {
      const title = normalize(raw.title);
      if (cardName && !cardName.split(" ").every((token) => title.includes(token))) return false;
      if (collector && !new RegExp(`(?:^|\\D)0*${collector}(?:\\D|$)`).test(title)) return false;
      return true;
    }).slice(0, 5).map((raw: any) => ({
      item_id: raw.itemId ?? null,
      title: raw.title ?? null,
      image_url: raw.image?.imageUrl ?? null,
      additional_images: Array.isArray(raw.additionalImages) ? raw.additionalImages.map((image: any) => image.imageUrl).filter(Boolean) : [],
      item_url: raw.itemWebUrl ?? null,
      price: raw.price ?? null,
      condition: safeEnum(raw.condition),
      source_label: "Reference Listing",
      market_label: "Active Asking Price",
      sold_comparable: false,
    }));
    return reply({ status: "success", source: "EBAY_BROWSE", active_listings_only: true, items });
  }

  if (operation === "account_sync") {
    const accountId = String(body.account_id ?? "");
    if (!accountId) return reply({ status: "error", error_code: "MISSING_ACCOUNT", message: "account_id is required." }, 400);
    const marketplaceId = String(body.marketplace_id ?? "EBAY_US");
    const admin = makeAdmin();
    const startedAt = Date.now();
    let accessToken: string;
    try {
      accessToken = await userAccessToken(admin, accountId);
    } catch {
      await admin.rpc("ebay_api_run_record", { p_account_id: accountId, p_operation: "account_sync", p_status: "error", p_http_status: null, p_request_id: null, p_latency_ms: Date.now() - startedAt, p_error_code: "reauthorization_required" });
      return unavailable(operation, "Connected eBay account");
    }

    // Per-resource api-run recorder — records AND checks the write; a failed
    // required-observability write is surfaced (never swallowed). Safe fields only.
    let observabilityFailed = false;
    const recordRun = async (op: string, status: string, http: number | null, latencyMs: number, errorCode: string | null): Promise<void> => {
      const { error } = await admin.rpc("ebay_api_run_record", { p_account_id: accountId, p_operation: op, p_status: status, p_http_status: http, p_request_id: null, p_latency_ms: Math.max(0, Math.round(latencyMs)), p_error_code: errorCode });
      if (error) observabilityFailed = true;
    };
    type ResView = { status: "success" | "unavailable" | "error"; http: number | null; count: number | null; error_code: string | null };
    const resources: Record<string, ResView> = {};

    // Identity on the apiz gateway (own latency; best-effort for the opaque id).
    let opaqueUserId: string | null = null;
    let identityOk = false;
    {
      const t0 = Date.now();
      try {
        const idRes = await fetch(`${ebayApizBase(MODE)}/commerce/identity/v1/user/`, { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } });
        if (idRes.ok) {
          const j = await idRes.json().catch(() => ({})) as Record<string, unknown>;
          opaqueUserId = typeof j.userId === "string" && j.userId ? j.userId : null;
          identityOk = Boolean(opaqueUserId); // HTTP 200 without a usable opaque id is NOT success
          resources.identity = { status: identityOk ? "success" : "unavailable", http: idRes.status || null, count: null, error_code: identityOk ? null : "identity_unavailable" };
        } else {
          resources.identity = { status: "error", http: idRes.status || null, count: null, error_code: "identity_request_failed" };
        }
      } catch { resources.identity = { status: "error", http: null, count: null, error_code: "identity_request_failed" }; }
      await recordRun("account_identity", resources.identity.status, resources.identity.http, Date.now() - t0, resources.identity.error_code);
    }

    // Read-only discovery on api.* — each fetch times itself.
    type Res = { ok: boolean; status: number; data: Record<string, unknown>; latency: number };
    const getJson = async (path: string): Promise<Res> => {
      const t0 = Date.now();
      try {
        const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "Content-Language": "en-US" } });
        return { ok: r.ok, status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, unknown>, latency: Date.now() - t0 };
      } catch { return { ok: false, status: 0, data: {}, latency: Date.now() - t0 }; }
    };
    const [priv, loc, ful, pay, ret] = await Promise.all([
      getJson("/sell/account/v1/privilege"),
      getJson("/sell/inventory/v1/location?limit=100"),
      getJson(`/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`),
      getJson(`/sell/account/v1/payment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`),
      getJson(`/sell/account/v1/return_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`),
    ]);

    resources.privileges = { status: priv.ok ? "success" : "error", http: priv.status || null, count: null, error_code: priv.ok ? null : "privilege_fetch_failed" };
    await recordRun("account_privileges", resources.privileges.status, resources.privileges.http, priv.latency, resources.privileges.error_code);

    let persistError: string | null = null;

    // Locations: fetch and persistence are SEPARATE runs, each with real latency;
    // the RPC returns the CONFIRMED post-write count (never the submitted rows).
    await recordRun("inventory_locations_fetch", loc.ok ? "success" : "error", loc.status || null, loc.latency, loc.ok ? null : "locations_fetch_failed");
    if (loc.ok) {
      const rows = (Array.isArray(loc.data.locations) ? loc.data.locations as Record<string, unknown>[] : [])
        .map((l) => ({ merchant_location_key: String(l.merchantLocationKey ?? ""), status: typeof l.merchantLocationStatus === "string" ? l.merchantLocationStatus : null, raw_enum_value: l.locationTypes != null ? JSON.stringify(l.locationTypes) : null }))
        .filter((l) => l.merchant_location_key);
      const t0 = Date.now();
      const { data, error } = await admin.rpc("ebay_inventory_locations_replace", { p_account_id: accountId, p_locations: rows });
      const lat = Date.now() - t0;
      if (error) { persistError = "locations_persist_failed"; resources.locations = { status: "error", http: loc.status || null, count: null, error_code: "locations_persist_failed" }; }
      else resources.locations = { status: "success", http: loc.status || null, count: typeof data === "number" ? data : null, error_code: null };
      await recordRun("inventory_locations_persistence", resources.locations.status, null, lat, resources.locations.error_code);
    } else {
      resources.locations = { status: "error", http: loc.status || null, count: null, error_code: "locations_fetch_failed" };
    }

    // Policies: record each FETCH as its own run with its REAL latency.
    await recordRun("fulfillment_policies_fetch", ful.ok ? "success" : "error", ful.status || null, ful.latency, ful.ok ? null : "fulfillment_policy_fetch_failed");
    await recordRun("payment_policies_fetch", pay.ok ? "success" : "error", pay.status || null, pay.latency, pay.ok ? null : "payment_policy_fetch_failed");
    await recordRun("return_policies_fetch", ret.ok ? "success" : "error", ret.status || null, ret.latency, ret.ok ? null : "return_policy_fetch_failed");

    const policyRows: Array<Record<string, unknown>> = [];
    const collect = (res: Res, key: string, idField: string, type: string): boolean => {
      if (!res.ok) return false;
      for (const p of (Array.isArray(res.data[key]) ? res.data[key] as Record<string, unknown>[] : [])) {
        policyRows.push({ policy_id: String(p[idField] ?? ""), policy_type: type, name: typeof p.name === "string" ? p.name : null, marketplace_id: typeof p.marketplaceId === "string" ? p.marketplaceId : marketplaceId });
      }
      return true;
    };
    const fOk = collect(ful, "fulfillmentPolicies", "fulfillmentPolicyId", "fulfillment");
    const pOk = collect(pay, "paymentPolicies", "paymentPolicyId", "payment");
    const rOk = collect(ret, "returnPolicies", "returnPolicyId", "return");
    const groupFetched = fOk && pOk && rOk;
    // Replace-with-prune only when all three fetched AND no earlier failure; the
    // RPC returns CONFIRMED post-write per-type counts. Its own real latency.
    let confirmed: { total: number; fulfillment: number; payment: number; return: number } | null = null;
    let policyPersistError: string | null = null;
    if (groupFetched && !persistError) {
      const t0 = Date.now();
      const { data, error } = await admin.rpc("ebay_business_policies_replace", { p_account_id: accountId, p_policies: policyRows.filter((p) => p.policy_id) });
      const lat = Date.now() - t0;
      if (error) { policyPersistError = "policies_persist_failed"; persistError = persistError ?? policyPersistError; }
      else if (data && typeof data === "object") confirmed = data as { total: number; fulfillment: number; payment: number; return: number };
      await recordRun("business_policies_persistence", error ? "error" : "success", null, lat, error ? "policies_persist_failed" : null);
    }
    // Fetched-but-not-persisted (incomplete group) → unavailable; earlier failure
    // → dependency error; persisted → success with ITS OWN CONFIRMED count.
    const policyView = (fetched: boolean, fetchCode: string, res: Res, type: "fulfillment" | "payment" | "return"): ResView => {
      if (!fetched) return { status: "error", http: res.status || null, count: null, error_code: fetchCode };
      if (!groupFetched) return { status: "unavailable", http: res.status || null, count: null, error_code: "policy_group_not_persisted_due_incomplete_fetch" };
      if (persistError) return { status: "error", http: res.status || null, count: null, error_code: policyPersistError ?? "policy_dependency_persist_failed" };
      return { status: "success", http: res.status || null, count: confirmed ? confirmed[type] : null, error_code: null };
    };
    resources.fulfillment_policies = policyView(fOk, "fulfillment_policy_fetch_failed", ful, "fulfillment");
    resources.payment_policies = policyView(pOk, "payment_policy_fetch_failed", pay, "payment");
    resources.return_policies = policyView(rOk, "return_policy_fetch_failed", ret, "return");

    const privilegeStatus = priv.ok ? "verified" : "unverified";
    const tAcct = Date.now();
    const { error: acctErr } = await admin.from("ebay_accounts").update({ connection_status: "connected", privilege_status: privilegeStatus }).eq("id", accountId);
    if (acctErr) persistError = persistError ?? "account_update_failed";
    await recordRun("account_update", acctErr ? "error" : "success", null, Date.now() - tAcct, acctErr ? "account_update_failed" : null);

    // Discovery is COMPLETE only when EVERY provider fetch (identity, privileges,
    // locations, all three policies) AND persistence succeeded. A partial run
    // (any provider fetch failed) records only the attempt and PRESERVES the prior
    // complete-discovery timestamp — a partial must never look like completion.
    const discoveredCount = (resources.locations.count ?? 0) + (resources.fulfillment_policies.count ?? 0) + (resources.payment_policies.count ?? 0) + (resources.return_policies.count ?? 0);
    const discoveryComplete = identityOk && priv.ok && loc.ok && groupFetched && !persistError;
    const tAtt = Date.now();
    const { error: attErr } = await admin.rpc("ebay_sync_cursor_touch", { p_account_id: accountId, p_resource_type: "account_discovery_attempt", p_count: discoveredCount });
    if (attErr && !persistError) persistError = "cursor_persist_failed";
    await recordRun("account_discovery_attempt", attErr ? "error" : "success", null, Date.now() - tAtt, attErr ? "cursor_persist_failed" : null);
    if (discoveryComplete && !attErr) {
      const tCmp = Date.now();
      const { error: cmpErr } = await admin.rpc("ebay_sync_cursor_touch", { p_account_id: accountId, p_resource_type: "account_discovery_complete", p_count: discoveredCount });
      if (cmpErr) persistError = "cursor_persist_failed";
      await recordRun("account_discovery_complete", cmpErr ? "error" : "success", null, Date.now() - tCmp, cmpErr ? "cursor_persist_failed" : null);
    }

    // A required-observability write failure is itself a durability failure.
    if (!persistError && observabilityFailed) persistError = "api_run_persist_failed";

    // Persistence failure → error(500); provider gap → partial.
    if (persistError) {
      await admin.rpc("ebay_api_run_record", { p_account_id: accountId, p_operation: "account_sync", p_status: "error", p_http_status: null, p_request_id: null, p_latency_ms: Math.max(0, Date.now() - startedAt), p_error_code: persistError });
      return reply({ status: "error", account_id: accountId, error_code: persistError, resources }, 500);
    }
    const overall = (identityOk && priv.ok && loc.ok && groupFetched) ? "success" : "partial";
    // The parent run is CHECKED: a lost parent audit row is a durability failure.
    // Do not recurse recording that failure through the same broken recorder.
    const { error: parentErr } = await admin.rpc("ebay_api_run_record", { p_account_id: accountId, p_operation: "account_sync", p_status: overall, p_http_status: null, p_request_id: null, p_latency_ms: Math.max(0, Date.now() - startedAt), p_error_code: overall === "partial" ? "partial_discovery" : null });
    if (parentErr) return reply({ status: "error", account_id: accountId, error_code: "parent_api_run_persist_failed", resources }, 500);
    // Counts + per-resource status only — never seller PII or raw provider bodies.
    return reply({ status: overall, account_id: accountId, opaque_user_id: opaqueUserId, privilege_status: privilegeStatus, resources });
  }

  const accountId = String(body.account_id ?? "");
  if (!accountId) return reply({ status: "error", error_code: "MISSING_ACCOUNT", message: "account_id is required." }, 400);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let accessToken: string;
  try { accessToken = await userAccessToken(admin, accountId); } catch { return unavailable(operation, "Connected eBay account"); }

  if (operation === "list_item") {
    const marketplaceId = String(body.marketplace_id ?? "EBAY_US");
    const categoryId = String(body.category_id ?? "");
    if (body.confirmation !== "PUBLISH") {
      // Preparation FAILS CLOSED: each requirement is fetched independently with
      // its own success/HTTP captured — a failed provider call is NOT masked as an
      // empty object. Only status "prepared" (all required resources ok) may let
      // the client enable Publish; any failure yields "partial".
      const probe = async (path: string): Promise<{ ok: boolean; http: number; data: Record<string, unknown> }> => {
        try {
          const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "Content-Language": "en-US" } });
          return { ok: r.ok, http: r.status, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
        } catch { return { ok: false, http: 0, data: {} }; }
      };
      const [priv, loc, ful, pay, ret] = await Promise.all([
        probe("/sell/account/v1/privilege"),
        probe("/sell/inventory/v1/location?limit=100"),
        probe(`/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`),
        probe(`/sell/account/v1/payment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`),
        probe(`/sell/account/v1/return_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`),
      ]);
      let aspects: { ok: boolean; http: number; data: Record<string, unknown> } | null = null;
      let conditions: { ok: boolean; http: number; data: Record<string, unknown> } | null = null;
      if (categoryId) {
        const tree = await probe(`/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${encodeURIComponent(marketplaceId)}`);
        if (tree.ok && tree.data.categoryTreeId) {
          aspects = await probe(`/commerce/taxonomy/v1/category_tree/${encodeURIComponent(String(tree.data.categoryTreeId))}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`);
          conditions = await probe(`/sell/metadata/v1/marketplace/${encodeURIComponent(marketplaceId)}/get_item_condition_policies?filter=categoryIds:%7B${encodeURIComponent(categoryId)}%7D`);
        } else {
          aspects = { ok: false, http: tree.http, data: {} };
          conditions = { ok: false, http: tree.http, data: {} };
        }
      }
      const rstat = (p: { ok: boolean; http: number } | null): { status: string; http: number | null } => p ? { status: p.ok ? "success" : "error", http: p.http || null } : { status: "not_requested", http: null };
      const requiredOk = priv.ok && loc.ok && ful.ok && pay.ok && ret.ok && (categoryId ? Boolean(aspects?.ok && conditions?.ok) : true);
      return reply({
        status: requiredOk ? "prepared" : "partial",
        confirmation_phrase: "PUBLISH",
        resources: {
          privileges: rstat(priv), inventory_locations: rstat(loc),
          fulfillment_policies: rstat(ful), payment_policies: rstat(pay), return_policies: rstat(ret),
          category_aspects: rstat(aspects), condition_policies: rstat(conditions),
        },
        privileges: priv.data, inventory_locations: loc.data,
        business_policies: { fulfillment: ful.data, payment: pay.data, return: ret.data },
        category_aspects: aspects?.data ?? null, condition_policies: conditions?.data ?? null,
        message: requiredOk
          ? "All listing requirements loaded. Review, resolve required aspects, and confirm PUBLISH."
          : "Some listing requirements could not be loaded — Publish stays blocked. See per-resource status.",
      });
    }
    // Publishing is a listing mutation: server flag gates it, and a confirmation
    // phrase cannot bypass a disabled flag.
    if (!flagEnabled(MUTATION_FLAGS.listing)) return mutationDisabled("list_item", "listing");
    const slabId = String(body.slab_id ?? "");
    const clientSku = String(body.sku ?? "");
    const merchantLocationKey = String(body.merchant_location_key ?? "");
    const fulfillmentPolicyId = String(body.fulfillment_policy_id ?? "");
    const paymentPolicyId = String(body.payment_policy_id ?? "");
    const returnPolicyId = String(body.return_policy_id ?? "");
    const priceValue = Number(body.price_value);
    const currency = String(body.currency ?? "USD");
    const condition = String(body.condition ?? "").trim();
    const title = String(body.title ?? "").trim();
    const description = String(body.description ?? "").trim();
    // Quantity is validated ONCE and reused everywhere (fingerprint, inventory,
    // offer, provider comparison): finite integer, 1..MAX.
    const MAX_QUANTITY = 999;
    const quantityRaw = body.quantity === undefined ? 1 : Number(body.quantity);
    const quantity = quantityRaw;
    if (!slabId || !categoryId || !merchantLocationKey || !fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId || !condition || !title || title.length > 80 || !description || currency !== "USD" || !Number.isFinite(priceValue) || priceValue <= 0) {
      return reply({ status: "error", error_code: "INCOMPLETE_LISTING", message: "Slab, category, location, all three policies, a non-empty condition, a 1–80 char title, a description, USD currency, and a positive price are all required." }, 400);
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      return reply({ status: "error", error_code: "invalid_quantity", message: `Quantity must be an integer between 1 and ${MAX_QUANTITY}.` }, 400);
    }

    // Fetch the slab and DERIVE the canonical SKU server-side — never trust body.sku.
    const { data: slabRow, error: slabErr } = await admin.from("slabs").select("inventory_number, front_image_path, back_image_path").eq("id", slabId).maybeSingle();
    if (slabErr) return reply({ status: "error", error_code: "slab_lookup_failed" }, 500);
    if (!slabRow) return reply({ status: "error", error_code: "slab_not_found" }, 404);
    const inventoryNumber = Number((slabRow as Record<string, unknown>).inventory_number);
    if (!Number.isFinite(inventoryNumber)) return reply({ status: "error", error_code: "slab_missing_inventory_number" }, 500);
    const sku = canonicalSkuFromInventoryNumber(inventoryNumber);
    if (clientSku && clientSku !== sku) return reply({ status: "error", error_code: "canonical_sku_mismatch", message: "The submitted SKU does not match the slab's canonical SKU." }, 400);
    if (!hasFrontImage((slabRow as Record<string, unknown>).front_image_path)) {
      return reply({ status: "error", error_code: "front_image_required", message: "A front image is required before publishing to eBay." }, 400);
    }

    // The location + all three policies MUST belong to THIS account (persisted
    // discovery), the location must be usable, and each policy's marketplace must
    // match — each with a DISTINCT error. A client-supplied foreign id is rejected.
    const [locOwn, fulOwn, payOwn, retOwn] = await Promise.all([
      admin.from("ebay_inventory_locations").select("merchant_location_key, status").eq("ebay_account_id", accountId).eq("merchant_location_key", merchantLocationKey).maybeSingle(),
      admin.from("ebay_business_policies").select("policy_id, marketplace_id").eq("ebay_account_id", accountId).eq("policy_id", fulfillmentPolicyId).eq("policy_type", "fulfillment").maybeSingle(),
      admin.from("ebay_business_policies").select("policy_id, marketplace_id").eq("ebay_account_id", accountId).eq("policy_id", paymentPolicyId).eq("policy_type", "payment").maybeSingle(),
      admin.from("ebay_business_policies").select("policy_id, marketplace_id").eq("ebay_account_id", accountId).eq("policy_id", returnPolicyId).eq("policy_type", "return").maybeSingle(),
    ]);
    if (locOwn.error || fulOwn.error || payOwn.error || retOwn.error) return reply({ status: "error", error_code: "ownership_check_failed" }, 500);
    if (!locOwn.data) return reply({ status: "error", error_code: "unknown_location", message: "The inventory location is not one of this account's discovered locations." }, 400);
    const locStatus = String((locOwn.data as Record<string, unknown>).status ?? "").toUpperCase();
    if (locStatus && locStatus !== "ENABLED") return reply({ status: "error", error_code: "location_not_enabled", message: "The selected inventory location is not enabled." }, 400);
    if (!fulOwn.data) return reply({ status: "error", error_code: "unknown_fulfillment_policy" }, 400);
    if (!payOwn.data) return reply({ status: "error", error_code: "unknown_payment_policy" }, 400);
    if (!retOwn.data) return reply({ status: "error", error_code: "unknown_return_policy" }, 400);
    const policyMarketplaceMismatch = [fulOwn, payOwn, retOwn].some((p) => {
      const m = String((p.data as Record<string, unknown>).marketplace_id ?? "");
      return m && m !== marketplaceId;
    });
    if (policyMarketplaceMismatch) return reply({ status: "error", error_code: "policy_marketplace_mismatch", message: "A selected business policy belongs to a different marketplace." }, 400);

    // Fresh signed image URLs immediately before the eBay mutation.
    const imageUrls: string[] = [];
    for (const path of orderedImagePaths((slabRow as Record<string, unknown>).front_image_path, (slabRow as Record<string, unknown>).back_image_path)) {
      const { data: signed, error: signErr } = await admin.storage.from("slab-images").createSignedUrl(path, 3600);
      if (signErr || !signed?.signedUrl) return reply({ status: "error", error_code: "image_url_generation_failed", message: "Could not generate a signed image URL for the listing." }, 502);
      imageUrls.push(signed.signedUrl);
    }
    if (imageUrls.length === 0) return reply({ status: "error", error_code: "front_image_required" }, 400);

    // RACE-SAFE single-flight: acquire a per-(account, SKU) publish lease so two
    // concurrent publishes cannot both pass the offer-existence check and each
    // create an offer. Released in the finally below on EVERY path.
    const leaseToken = crypto.randomUUID();
    const acq = await admin.rpc("ebay_publish_lease_acquire", { p_account_id: accountId, p_sku: sku, p_token: leaseToken, p_ttl_seconds: 120 });
    if (acq.error) return reply({ status: "error", error_code: "lease_acquire_failed" }, 500);
    if (!(acq.data as { acquired?: boolean } | null)?.acquired) return reply({ status: "publish_in_progress", message: "Another publish for this SKU is already in progress." }, 409);
    try {
    // Durable intent BEFORE any eBay mutation. A FAILED lookup is an error, never
    // silently "no existing intent".
    const { data: existing, error: lookupErr } = await admin.from("ebay_listing_intents").select("id, status, offer_id, listing_id, fingerprint").eq("ebay_account_id", accountId).eq("sku", sku).maybeSingle();
    if (lookupErr) return reply({ status: "error", error_code: "listing_intent_lookup_failed" }, 500);
    const existingIntent = existing as { id: string; status: string; offer_id: string | null; listing_id: string | null; fingerprint: string | null } | null;
    const fingerprint = listingFingerprint({
      sku, title, description, price_value: priceValue, currency, category_id: categoryId,
      merchant_location_key: merchantLocationKey, fulfillment_policy_id: fulfillmentPolicyId,
      payment_policy_id: paymentPolicyId, return_policy_id: returnPolicyId, condition,
      condition_description: String(body.condition_description ?? ""), quantity,
      front_image_path: String((slabRow as Record<string, unknown>).front_image_path ?? ""),
      back_image_path: (slabRow as Record<string, unknown>).back_image_path ? String((slabRow as Record<string, unknown>).back_image_path) : "",
      aspects: (body.aspects && typeof body.aspects === "object" ? body.aspects : {}) as Record<string, unknown>,
    });

    // Fingerprint enforcement (pure decision): never silently reuse a stale offer
    // or re-publish over a live listing when inputs changed.
    const decision = resolvePublishAction(existingIntent, fingerprint);
    if (decision.action === "offer_created_unpersisted") {
      return reply({ status: "offer_created_unpersisted", message: "A prior publish created an eBay offer that was not saved locally. Run reconcile (which recovers the offer by SKU) before publishing this SKU again." }, 409);
    }
    if (decision.action === "reconciled_existing") {
      return reply({ status: "success", reconciled: true, offer_id: existingIntent?.offer_id, listing_id: existingIntent?.listing_id, listing_status: "published" });
    }
    if (decision.action === "listing_inputs_changed") {
      return reply({ status: "listing_inputs_changed", offer_id: existingIntent?.offer_id, listing_id: existingIntent?.listing_id ?? undefined, message: "The listing inputs changed relative to the existing intent/listing for this SKU. Use an explicit revise flow — publish will not silently change a live listing or reuse a stale offer." }, 409);
    }

    const { data: intentRow, error: intentErr0 } = await admin.from("ebay_listing_intents").upsert({ ebay_account_id: accountId, slab_id: slabId, sku, fingerprint, status: "preparing", last_error: null, updated_at: new Date().toISOString() }, { onConflict: "ebay_account_id,sku" }).select("id").single();
    if (intentErr0 || !intentRow) return reply({ status: "error", error_code: "listing_intent_persist_failed" }, 500);
    const intentId = (intentRow as { id: string }).id;
    // Resume an existing offer ONLY on a fingerprint match (decided above).
    let offerId = decision.action === "resume" ? decision.offerId : "";

    const inventoryPayload = {
      availability: { shipToLocationAvailability: { quantity } },
      condition,
      conditionDescription: body.condition_description ?? undefined,
      product: { title, description, aspects: body.aspects ?? {}, imageUrls },
    };
    // FENCE: confirm we still hold the lease before the first provider mutation.
    if (!(await assertLeaseHeld(admin, accountId, sku, leaseToken))) return reply({ status: "publish_lease_lost", message: "The publish lease was lost or superseded; aborting before any eBay mutation." }, 409);
    await ebayFetch(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, accessToken, { method: "PUT", body: JSON.stringify(inventoryPayload) });
    // Inventory item PUT is idempotent by SKU, but the status transition is still
    // checked; a lost transition returns error and a retry re-PUTs safely.
    const { error: invErr } = await admin.from("ebay_listing_intents").update({ status: "inventory_created", updated_at: new Date().toISOString() }).eq("id", intentId);
    if (invErr) return reply({ status: "error", error_code: "listing_intent_persist_failed" }, 500);

    // Create the offer ONLY if we do not already have one, so a retried publish
    // never creates a duplicate offer. Persist offer_id BEFORE publish, and STOP
    // if that persistence fails (a lost offer_id would risk a duplicate on retry).
    if (!offerId) {
      // PROVIDER-SIDE idempotency: ask eBay what offers already exist for this SKU
      // BEFORE creating one. This makes a retry safe even if EVERY prior local
      // write (offer_id persistence AND its recovery) failed — we adopt the
      // orphaned offer instead of creating a duplicate. A lookup failure is an
      // error (never treated as "none exist").
      // FENCE before the provider lookup.
      if (!(await assertLeaseHeld(admin, accountId, sku, leaseToken))) return reply({ status: "publish_lease_lost" }, 409);
      // Discovery FAILS CLOSED: a loop, page-cap, unsafe next url, incomplete
      // provider result, or lookup failure all block offer creation — never a
      // partial collection read as "complete/none".
      const lookup = await discoverOffers(accessToken, sku);
      if (!lookup.ok) {
        const { error: discErr } = await admin.from("ebay_listing_intents").update({ status: "offer_discovery_failed", last_error: `${lookup.errorCode}:${lookup.httpStatus ?? ""}`, updated_at: new Date().toISOString() }).eq("id", intentId);
        return reply({ status: "error", error_code: lookup.errorCode, http: lookup.httpStatus, provider_error_id: lookup.safeProviderErrorId, intent_persist_failed: !!discErr, message: "Could not COMPLETELY verify existing eBay offers for this SKU; refusing to create a possibly-duplicate offer." }, 502);
      }
      // FULL content validation: compatibility (SKU+marketplace+FIXED_PRICE) AND a
      // field-by-field match against intent — never adopt/publish a stale offer.
      const intendedOffer = { sku, marketplaceId, categoryId, merchantLocationKey, fulfillmentPolicyId, paymentPolicyId, returnPolicyId, price: priceValue, currency, availableQuantity: quantity };
      const offerDecision = resolveExistingOffers(lookup.offers, intendedOffer);
      if (offerDecision.action === "duplicate_offer_ambiguity") {
        await admin.from("ebay_listing_intents").update({ status: "duplicate_offer_ambiguity", last_error: `offer_ids:${offerDecision.offerIds.join(",")}`, updated_at: new Date().toISOString() }).eq("id", intentId);
        return reply({ status: "duplicate_offer_ambiguity", offer_ids: offerDecision.offerIds, message: "eBay already has multiple compatible offers for this SKU. Resolve them before publishing." }, 409);
      }
      if (offerDecision.action === "listing_on_hold") {
        await admin.from("ebay_listing_intents").update({ status: "listing_on_hold", offer_id: offerDecision.offerId, updated_at: new Date().toISOString() }).eq("id", intentId);
        return reply({ status: "listing_on_hold", offer_id: offerDecision.offerId, message: "eBay reports the existing listing for this SKU is on hold; resolve it before publishing." }, 409);
      }
      if (offerDecision.action === "existing_offer_inputs_changed") {
        return reply({ status: "existing_offer_inputs_changed", offer_id: offerDecision.offerId, message: "An unpublished eBay offer exists for this SKU with DIFFERENT settings. Revise it explicitly — publish will not overwrite it silently." }, 409);
      }
      if (offerDecision.action === "existing_listing_inputs_changed") {
        return reply({ status: "existing_listing_inputs_changed", offer_id: offerDecision.offerId, listing_id: offerDecision.listingId, message: "A LIVE eBay listing exists for this SKU with DIFFERENT settings. Use an explicit revise flow." }, 409);
      }
      if (offerDecision.action === "reconcile_published") {
        // A matching offer is ALREADY published — adopt it locally, do NOT publish again.
        const { error: mapErr } = await admin.from("ebay_listing_mappings").upsert({ slab_id: slabId, ebay_account_id: accountId, sku, offer_id: offerDecision.offerId, listing_id: offerDecision.listingId, listing_status: "published", asking_price_cents: Math.round(priceValue * 100), currency, last_synced_at: new Date().toISOString() }, { onConflict: "ebay_account_id,sku" });
        const { error: intUpd } = await admin.from("ebay_listing_intents").update({ status: "published", offer_id: offerDecision.offerId, listing_id: offerDecision.listingId, updated_at: new Date().toISOString() }).eq("id", intentId);
        if (mapErr || intUpd) return reply({ status: "published_unmapped", offer_id: offerDecision.offerId, listing_id: offerDecision.listingId, message: "eBay already has a live listing for this SKU but the local mapping write failed — run reconcile." }, 500);
        return reply({ status: "success", reconciled: true, offer_id: offerDecision.offerId, listing_id: offerDecision.listingId, listing_status: "published" });
      }
      if (offerDecision.action === "adopt") {
        offerId = offerDecision.offerId; // reuse the existing MATCHING offer; do NOT create another
      } else {
        // FENCE before creating the offer.
        if (!(await assertLeaseHeld(admin, accountId, sku, leaseToken))) return reply({ status: "publish_lease_lost" }, 409);
        const offer = await ebayFetch("/sell/inventory/v1/offer", accessToken, { method: "POST", body: JSON.stringify({
          sku, marketplaceId, format: "FIXED_PRICE", availableQuantity: quantity, categoryId, merchantLocationKey,
          listingDescription: description, pricingSummary: { price: { currency, value: priceValue.toFixed(2) } },
          listingPolicies: { fulfillmentPolicyId, paymentPolicyId, returnPolicyId },
        }) });
        offerId = String(offer.offerId ?? "");
        if (!offerId) { await admin.from("ebay_listing_intents").update({ status: "failed", last_error: "no_offer_id", updated_at: new Date().toISOString() }).eq("id", intentId); return reply({ status: "error", error_code: "offer_creation_failed" }, 502); }
      }
      // Persist offer_id. If this fails, the next attempt's provider lookup will
      // still find the offer and adopt it — no duplicate — but flag it anyway.
      const { error: ocErr } = await admin.from("ebay_listing_intents").update({ status: "offer_created", offer_id: offerId, updated_at: new Date().toISOString() }).eq("id", intentId);
      if (ocErr) {
        await admin.from("ebay_listing_intents").update({ status: "offer_created_unpersisted", last_error: `offer_id_persist_failed:${offerId}`, updated_at: new Date().toISOString() }).eq("id", intentId);
        return reply({ status: "offer_created_unpersisted", offer_id: offerId, message: "An eBay offer exists but its ID could not be saved locally. Run reconcile; a retry will re-adopt it (no duplicate) via the provider lookup." }, 500);
      }
    }

    // FENCE before publishing the offer.
    if (!(await assertLeaseHeld(admin, accountId, sku, leaseToken))) return reply({ status: "publish_lease_lost" }, 409);
    const published = await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, accessToken, { method: "POST", body: "{}" });
    const listingId = published.listingId ? String(published.listingId) : null;

    // The external listing now EXISTS. If local persistence fails here, this is
    // NOT a normal success — it is published_unmapped, and we do NOT withdraw.
    const { error: intentErr } = await admin.from("ebay_listing_intents").update({ status: "published", listing_id: listingId, updated_at: new Date().toISOString() }).eq("id", intentId);
    const { error: mapErr } = await admin.from("ebay_listing_mappings").upsert({ slab_id: slabId, ebay_account_id: accountId, sku, offer_id: offerId, listing_id: listingId, listing_status: "published", asking_price_cents: Math.round(priceValue * 100), currency, last_synced_at: new Date().toISOString() }, { onConflict: "ebay_account_id,sku" });
    if (intentErr || mapErr) {
      await admin.from("ebay_listing_intents").update({ status: "published_unmapped", offer_id: offerId, listing_id: listingId, last_error: "local_persist_failed", updated_at: new Date().toISOString() }).eq("id", intentId);
      return reply({ status: "published_unmapped", offer_id: offerId, listing_id: listingId, message: "The eBay listing is LIVE but local reconciliation failed. The listing was NOT withdrawn — run reconcile to repair the local mapping." }, 500);
    }
    return reply({ status: "success", offer_id: offerId, listing_id: listingId, listing_status: "published" });
    } finally {
      // Release the publish lease on EVERY path (success, error, or throw), and
      // record a safe diagnostic if the release did not remove our row.
      const rel = await admin.rpc("ebay_publish_lease_release", { p_account_id: accountId, p_sku: sku, p_token: leaseToken });
      if (rel.error || !(rel.data as { released?: boolean } | null)?.released) {
        await admin.rpc("ebay_api_run_record", { p_account_id: accountId, p_operation: "publish_lease_release", p_status: "error", p_http_status: null, p_request_id: null, p_latency_ms: 0, p_error_code: "lease_release_unconfirmed" });
      }
    }
  }

  if (operation === "revise_item" && body.action === "reconcile") {
    // Reconcile from the PROVIDER, using the server-derived canonical SKU (never
    // trust body.sku), the shared paginated getOffers, and NEVER a stale local
    // offer id as proof — the offer id comes only from eBay's response.
    const slabId = String(body.slab_id ?? "");
    const clientSku = String(body.sku ?? "");
    if (!slabId) return reply({ status: "error", error_code: "MISSING_SLAB", message: "slab_id is required to reconcile." }, 400);
    const { data: slabRow, error: slabErr } = await admin.from("slabs").select("inventory_number").eq("id", slabId).maybeSingle();
    if (slabErr) return reply({ status: "error", error_code: "slab_lookup_failed" }, 500);
    if (!slabRow) return reply({ status: "error", error_code: "slab_not_found" }, 404);
    const inv = Number((slabRow as Record<string, unknown>).inventory_number);
    if (!Number.isFinite(inv)) return reply({ status: "error", error_code: "slab_missing_inventory_number" }, 500);
    const sku = canonicalSkuFromInventoryNumber(inv);
    if (clientSku && clientSku !== sku) return reply({ status: "error", error_code: "canonical_sku_mismatch" }, 400);

    const { data: intentRow, error: intentLookupErr } = await admin.from("ebay_listing_intents").select("id, slab_id, status").eq("ebay_account_id", accountId).eq("sku", sku).maybeSingle();
    if (intentLookupErr) return reply({ status: "error", error_code: "listing_intent_lookup_failed" }, 500);
    const intent = intentRow as { id: string; slab_id: string | null; status: string } | null;
    if (!intent) return reply({ status: "error", error_code: "no_listing_intent", message: "No listing intent exists for this SKU." }, 404);

    const lookup = await discoverOffers(accessToken, sku);
    if (!lookup.ok) {
      const code = lookup.httpStatus === 401 || lookup.httpStatus === 403 ? "authorization_failed" : lookup.errorCode;
      // Record the discovery failure on the intent (checked) before returning.
      const { error: discErr } = await admin.from("ebay_listing_intents").update({ status: "offer_discovery_failed", last_error: `${lookup.errorCode}:${lookup.httpStatus ?? ""}`, updated_at: new Date().toISOString() }).eq("id", intent.id);
      return reply({ status: "error", error_code: code, http: lookup.httpStatus, provider_error_id: lookup.safeProviderErrorId, intent_persist_failed: !!discErr, message: "Could not COMPLETELY verify the eBay offer for this SKU; cannot distinguish 'no offer' from a lookup/discovery failure." }, 502);
    }
    if (lookup.offers.length > 1) {
      return reply({ status: "duplicate_offer_ambiguity", offer_ids: lookup.offers.map((o) => o.offerId), message: "eBay has multiple offers for this SKU; resolve them before reconciling." }, 409);
    }
    const live = lookup.offers[0];
    if (!live) return reply({ status: "error", error_code: "no_live_offer", message: "eBay confirms no offer exists for this SKU; nothing to reconcile." }, 404);
    const offerId = live.offerId; // ONLY the provider's offer id — never a stale local one
    const listingId = live.listingId;
    const recoveredStatus = listingId ? "published" : "offer_created";
    if (recoveredStatus === "published") {
      const { error: mapErr } = await admin.from("ebay_listing_mappings").upsert({ slab_id: intent.slab_id, ebay_account_id: accountId, sku, offer_id: offerId, listing_id: listingId, listing_status: "published", last_synced_at: new Date().toISOString() }, { onConflict: "ebay_account_id,sku" });
      if (mapErr) return reply({ status: "error", error_code: "reconcile_persist_failed" }, 500);
    }
    const { error: intentUpdErr } = await admin.from("ebay_listing_intents").update({ status: recoveredStatus, offer_id: offerId, listing_id: listingId, last_error: null, updated_at: new Date().toISOString() }).eq("id", intent.id);
    if (intentUpdErr) return reply({ status: "error", error_code: "reconcile_persist_failed" }, 500);
    return reply({ status: "success", reconciled: true, offer_id: offerId, listing_id: listingId, listing_status: recoveredStatus });
  }

  if (operation === "revise_item") {
    if (!flagEnabled(MUTATION_FLAGS.listing)) return mutationDisabled("revise_item", "listing");
    const needs = confirmation(body, "REVISE"); if (needs) return needs;
    const offerId = String(body.offer_id ?? "");
    if (!offerId) return reply({ status: "error", error_code: "MISSING_OFFER", message: "offer_id is required." }, 400);
    const patch: Record<string, unknown> = {};
    if (body.price_value !== undefined) patch.pricingSummary = { price: { currency: String(body.currency ?? "USD"), value: Number(body.price_value).toFixed(2) } };
    if (body.quantity !== undefined) patch.availableQuantity = Number(body.quantity);
    await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, accessToken, { method: "PUT", body: JSON.stringify(patch) });
    const { error: revMapErr } = await admin.from("ebay_listing_mappings").update({ asking_price_cents: body.price_value === undefined ? undefined : Math.round(Number(body.price_value) * 100), last_synced_at: new Date().toISOString() }).eq("ebay_account_id", accountId).eq("offer_id", offerId);
    if (revMapErr) return reply({ status: "revise_unmapped", offer_id: offerId, message: "eBay revise succeeded but the local mapping update failed." }, 500);
    return reply({ status: "success", offer_id: offerId, listing_status: "published" });
  }

  if (operation === "end_item") {
    if (!flagEnabled(MUTATION_FLAGS.listing)) return mutationDisabled("end_item", "listing");
    const needs = confirmation(body, "END"); if (needs) return needs;
    const offerId = String(body.offer_id ?? "");
    await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`, accessToken, { method: "POST", body: "{}" });
    const { error: endMapErr } = await admin.from("ebay_listing_mappings").update({ listing_status: "ended", last_synced_at: new Date().toISOString() }).eq("ebay_account_id", accountId).eq("offer_id", offerId);
    if (endMapErr) return reply({ status: "end_unmapped", offer_id: offerId, message: "eBay withdraw succeeded but the local mapping update failed." }, 500);
    return reply({ status: "success", offer_id: offerId, listing_status: "ended" });
  }

  if (operation === "order_sync") {
    // APPLY_SALES is a SEPARATE consequential local-inventory action operating
    // ONLY over already-persisted lines. It never re-fetches or re-persists
    // provider orders, and it is gated by its own server flag + typed phrase.
    if (body.confirmation === "APPLY_SALES") {
      if (!flagEnabled(MUTATION_FLAGS.applySales)) return mutationDisabled("order_sync", "apply-sales");
      const sales = Array.isArray(body.sales) ? body.sales : [];
      if (sales.length === 0) return reply({ status: "error", error_code: "no_sales_selected", message: "No persisted sale lines were selected to apply." }, 400);
      const ta = Date.now();
      const { data: applied, error: applyErr } = await admin.rpc("ebay_sales_apply", { p_account_id: accountId, p_sales: sales });
      const runOk = await recordApiRun(admin, accountId, "apply_sales", applyErr ? "error" : "success", Date.now() - ta, applyErr ? "sales_apply_failed" : null);
      if (applyErr) return reply({ status: "error", error_code: "sales_apply_failed" }, 500);
      if (!runOk) return reply({ status: "error", error_code: "api_run_persist_failed" }, 500);
      const a = (applied && typeof applied === "object" ? applied : {}) as { applied?: number; skipped_stale?: number; skipped_unmatched?: number };
      return reply({ status: "success", mode: "sales_applied", sales_applied: a.applied ?? 0, skipped_stale: a.skipped_stale ?? 0, skipped_unmatched: a.skipped_unmatched ?? 0 });
    }

    // DEFAULT: non-destructive inbound sync. Fetch → resolve SKU→slab mappings
    // (one batched query) → PERSIST orders + lines (never touches slab inventory
    // or sold_comps). The parent api-run is recorded ONLY after every required
    // write (persist + cursor) succeeds; a cursor failure makes the parent error.
    const t0 = Date.now();
    const data = await ebayFetch("/sell/fulfillment/v1/order?limit=200", accessToken);
    const fetchedOrders = Array.isArray(data.orders) ? data.orders.length : 0;
    const skus = skusFromOrders(data.orders);
    const mappingBySku = new Map<string, string>();
    if (skus.length) {
      const { data: rows, error: mapErr } = await admin.from("ebay_listing_mappings").select("sku, slab_id").eq("ebay_account_id", accountId).in("sku", skus);
      // A failed mapping read must NOT masquerade as "no mappings" (all-unmatched).
      if (mapErr) {
        await recordApiRun(admin, accountId, "order_sync", "error", Date.now() - t0, "mapping_lookup_failed");
        return reply({ status: "error", error_code: "mapping_lookup_failed" }, 500);
      }
      for (const m of (rows ?? []) as Array<{ sku: string; slab_id: string | null }>) {
        if (m.sku && m.slab_id) mappingBySku.set(m.sku, m.slab_id);
      }
    }
    const { shaped, proposed_sales, order_count, line_item_count } = shapeEbayOrders(data.orders, mappingBySku);

    const { data: persisted, error: persistErr } = await admin.rpc("ebay_orders_persist", { p_account_id: accountId, p_orders: shaped });
    if (persistErr) {
      await recordApiRun(admin, accountId, "order_sync", "error", Date.now() - t0, "orders_persist_failed");
      return reply({ status: "error", error_code: "orders_persist_failed" }, 500);
    }
    const p = (persisted && typeof persisted === "object" ? persisted : {}) as { orders?: number; line_items?: number; matched?: number; unmatched?: number };
    const { error: curErr } = await admin.rpc("ebay_sync_cursor_touch", { p_account_id: accountId, p_resource_type: "orders", p_count: p.orders ?? 0 });
    if (curErr) {
      await recordApiRun(admin, accountId, "order_sync", "error", Date.now() - t0, "orders_cursor_persist_failed");
      return reply({ status: "error", error_code: "orders_cursor_persist_failed" }, 500);
    }
    const runOk = await recordApiRun(admin, accountId, "order_sync", "success", Date.now() - t0, null);
    if (!runOk) return reply({ status: "error", error_code: "api_run_persist_failed" }, 500);
    return reply({
      status: "success", mode: "synced",
      fetched_orders: fetchedOrders, valid_orders: order_count, fetched_lines: line_item_count,
      persisted_orders: p.orders ?? 0, persisted_lines: p.line_items ?? 0,
      matched: p.matched ?? 0, unmatched: p.unmatched ?? 0,
      orders_synced: p.orders ?? 0, line_items_synced: p.line_items ?? 0, // back-compat aliases
      proposed_sales, proposed_sale_count: proposed_sales.length,
      message: `${fetchedOrders} fetched · ${p.orders ?? 0} persisted · ${p.matched ?? 0} matched · ${p.unmatched ?? 0} unmatched · ${proposed_sales.length} proposed sale(s).`,
      source_label: "Seller’s Completed Sale",
    });
  }

  if (operation === "fulfillment") {
    const action = String(body.action ?? "ship");
    // Ship is a fulfillment mutation; refund moves money (financial mutation).
    if (action === "refund" && !flagEnabled(MUTATION_FLAGS.financial)) return mutationDisabled("fulfillment", "financial");
    if (action !== "refund" && !flagEnabled(MUTATION_FLAGS.fulfillment)) return mutationDisabled("fulfillment", "fulfillment");
    const phrase = action === "refund" ? "REFUND" : "SHIP";
    const needs = confirmation(body, phrase); if (needs) return needs;
    const orderId = String(body.order_id ?? "");
    if (action === "refund") {
      const result = await ebayFetch(`/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/issue_refund`, accessToken, { method: "POST", body: JSON.stringify(body.refund ?? {}) });
      return reply({ status: "success", action: "refund", order_id: orderId, refund_id: result.refundId ?? null });
    }
    const payload = { lineItems: body.line_items ?? [], shippedDate: body.shipped_at ?? new Date().toISOString(), shippingCarrierCode: body.shipping_carrier_code, trackingNumber: body.tracking_number };
    const result = await ebayFetch(`/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`, accessToken, { method: "POST", body: JSON.stringify(payload) });
    return reply({ status: "success", action: "ship", order_id: orderId, fulfillment_id: result.fulfillmentId ?? null });
  }

  if (operation === "finances_sync") {
    // Inbound finance sync is READ-only (recording fees/payouts), so it is not
    // gated by a mutation flag. The Finances API is on the apiz gateway, NOT api.*.
    const t0 = Date.now();
    const data = await ebayFetchBase(ebayApizBase(MODE), "/sell/finances/v1/transaction?limit=200", accessToken);
    const fetched = Array.isArray(data.transactions) ? data.transactions.length : 0;
    const shaped = shapeEbayFinanceTransactions(data.transactions); // valid (non-empty transaction id)
    const { data: result, error } = await admin.rpc("ebay_finance_transactions_apply", { p_account_id: accountId, p_transactions: shaped });
    if (error) {
      await recordApiRun(admin, accountId, "finances_sync", "error", Date.now() - t0, "finances_apply_failed");
      return reply({ status: "error", error_code: "finances_apply_failed" }, 500);
    }
    const r = (result && typeof result === "object" ? result : {}) as { transactions?: number; total?: number };
    const durableTotal = r.total ?? null; // CONFIRMED unique rows for the account
    // The cursor tracks the DURABLE unique-row total, never the processed count
    // (so 8 fetched + 1 duplicate → cursor 7, not 8).
    const { error: curErr } = await admin.rpc("ebay_sync_cursor_touch", { p_account_id: accountId, p_resource_type: "finances", p_count: durableTotal ?? 0 });
    if (curErr) {
      await recordApiRun(admin, accountId, "finances_sync", "error", Date.now() - t0, "finances_cursor_persist_failed");
      return reply({ status: "error", error_code: "finances_cursor_persist_failed" }, 500);
    }
    const runOk = await recordApiRun(admin, accountId, "finances_sync", "success", Date.now() - t0, null);
    if (!runOk) return reply({ status: "error", error_code: "api_run_persist_failed" }, 500);
    return reply({
      status: "success",
      fetched, valid: shaped.length, processed: r.transactions ?? 0, confirmed_total: durableTotal,
      financial_transactions_synced: r.transactions ?? 0, financial_transactions_total: durableTotal, // back-compat
      note: "Fees/payouts stored privately; the cursor reflects durable unique rows. Unknown enum/CustomCode values preserved in raw_response.",
    });
  }

  return unavailable(operation, "eBay seller API capability");
}
