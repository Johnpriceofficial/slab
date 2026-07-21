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

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

async function ebayFetch(path: string, token: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, {
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

function moneyCents(money: unknown): number | null {
  if (!money || typeof money !== "object") return null;
  const value = Number((money as Record<string, unknown>).value);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

function confirmation(body: Record<string, unknown>, phrase: string): Response | null {
  if (body.confirmation === phrase) return null;
  return reply({
    status: "confirmation_required",
    confirmation_phrase: phrase,
    message: `Review the marketplace payload and explicitly confirm ${phrase} before this external mutation runs.`,
  }, 409);
}

async function userAccessToken(admin: ReturnType<typeof createClient>, accountId: string): Promise<string> {
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
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
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
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
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
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
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
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
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

    if (!persistError) {
      const tCur = Date.now();
      const { error: curErr } = await admin.rpc("ebay_sync_cursor_touch", { p_account_id: accountId, p_resource_type: "account_discovery", p_count: (resources.locations.count ?? 0) + (resources.fulfillment_policies.count ?? 0) + (resources.payment_policies.count ?? 0) + (resources.return_policies.count ?? 0) });
      if (curErr) persistError = "cursor_persist_failed";
      await recordRun("account_discovery_cursor", curErr ? "error" : "success", null, Date.now() - tCur, curErr ? "cursor_persist_failed" : null);
    } else {
      await recordRun("account_discovery_cursor", "error", null, 0, persistError);
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
      const [privileges, locations, fulfillment, payment, returns] = await Promise.all([
        ebayFetch("/sell/account/v1/privilege", accessToken).catch(() => ({})),
        ebayFetch("/sell/inventory/v1/location?limit=100", accessToken).catch(() => ({})),
        ebayFetch(`/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`, accessToken).catch(() => ({})),
        ebayFetch(`/sell/account/v1/payment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`, accessToken).catch(() => ({})),
        ebayFetch(`/sell/account/v1/return_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`, accessToken).catch(() => ({})),
      ]);
      let categoryRequirements: Record<string, unknown> | null = null;
      let conditionPolicies: Record<string, unknown> | null = null;
      if (categoryId) {
        const tree = await ebayFetch(`/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${encodeURIComponent(marketplaceId)}`, accessToken);
        categoryRequirements = await ebayFetch(`/commerce/taxonomy/v1/category_tree/${encodeURIComponent(String(tree.categoryTreeId))}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`, accessToken);
        conditionPolicies = await ebayFetch(`/sell/metadata/v1/marketplace/${encodeURIComponent(marketplaceId)}/get_item_condition_policies?filter=categoryIds:%7B${encodeURIComponent(categoryId)}%7D`, accessToken);
      }
      return reply({
        status: "confirmation_required",
        confirmation_phrase: "PUBLISH",
        privileges,
        inventory_locations: locations,
        business_policies: { fulfillment, payment, return: returns },
        category_aspects: categoryRequirements,
        condition_policies: conditionPolicies,
        message: "Resolve the current eBay category, aspects, condition policy, business policies, and inventory location, then explicitly confirm PUBLISH.",
      }, 409);
    }
    const slabId = String(body.slab_id ?? "");
    const sku = String(body.sku ?? "");
    const merchantLocationKey = String(body.merchant_location_key ?? "");
    const fulfillmentPolicyId = String(body.fulfillment_policy_id ?? "");
    const paymentPolicyId = String(body.payment_policy_id ?? "");
    const returnPolicyId = String(body.return_policy_id ?? "");
    const priceValue = Number(body.price_value);
    if (!slabId || !sku || !categoryId || !merchantLocationKey || !fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId || !Number.isFinite(priceValue)) {
      return reply({ status: "error", error_code: "INCOMPLETE_LISTING", message: "Slab, SKU, category, location, policies, condition, and price are required." }, 400);
    }
    const inventoryPayload = {
      availability: { shipToLocationAvailability: { quantity: Number(body.quantity ?? 1) } },
      condition: String(body.condition ?? ""),
      conditionDescription: body.condition_description ?? undefined,
      product: {
        title: String(body.title ?? ""),
        description: String(body.description ?? ""),
        aspects: body.aspects ?? {},
        imageUrls: Array.isArray(body.image_urls) ? body.image_urls : [],
      },
    };
    await ebayFetch(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, accessToken, { method: "PUT", body: JSON.stringify(inventoryPayload) });
    const offer = await ebayFetch("/sell/inventory/v1/offer", accessToken, { method: "POST", body: JSON.stringify({
      sku,
      marketplaceId,
      format: "FIXED_PRICE",
      availableQuantity: Number(body.quantity ?? 1),
      categoryId,
      merchantLocationKey,
      listingDescription: String(body.description ?? ""),
      pricingSummary: { price: { currency: String(body.currency ?? "USD"), value: priceValue.toFixed(2) } },
      listingPolicies: { fulfillmentPolicyId, paymentPolicyId, returnPolicyId },
    }) });
    const offerId = String(offer.offerId ?? "");
    if (!offerId) throw new Error("eBay did not return an offer ID.");
    const published = await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, accessToken, { method: "POST", body: "{}" });
    await admin.from("ebay_listing_mappings").upsert({
      slab_id: slabId, ebay_account_id: accountId, sku, offer_id: offerId,
      listing_id: published.listingId ?? null, listing_status: "published",
      asking_price_cents: Math.round(priceValue * 100), currency: String(body.currency ?? "USD"), last_synced_at: new Date().toISOString(),
    }, { onConflict: "ebay_account_id,sku" });
    return reply({ status: "success", offer_id: offerId, listing_id: published.listingId ?? null, listing_status: "published" });
  }

  if (operation === "revise_item") {
    const needs = confirmation(body, "REVISE"); if (needs) return needs;
    const offerId = String(body.offer_id ?? "");
    if (!offerId) return reply({ status: "error", error_code: "MISSING_OFFER", message: "offer_id is required." }, 400);
    const patch: Record<string, unknown> = {};
    if (body.price_value !== undefined) patch.pricingSummary = { price: { currency: String(body.currency ?? "USD"), value: Number(body.price_value).toFixed(2) } };
    if (body.quantity !== undefined) patch.availableQuantity = Number(body.quantity);
    await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, accessToken, { method: "PUT", body: JSON.stringify(patch) });
    await admin.from("ebay_listing_mappings").update({ asking_price_cents: body.price_value === undefined ? undefined : Math.round(Number(body.price_value) * 100), last_synced_at: new Date().toISOString() }).eq("ebay_account_id", accountId).eq("offer_id", offerId);
    return reply({ status: "success", offer_id: offerId, listing_status: "published" });
  }

  if (operation === "end_item") {
    const needs = confirmation(body, "END"); if (needs) return needs;
    const offerId = String(body.offer_id ?? "");
    await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`, accessToken, { method: "POST", body: "{}" });
    await admin.from("ebay_listing_mappings").update({ listing_status: "ended", last_synced_at: new Date().toISOString() }).eq("ebay_account_id", accountId).eq("offer_id", offerId);
    return reply({ status: "success", offer_id: offerId, listing_status: "ended" });
  }

  if (operation === "order_sync") {
    const data = await ebayFetch("/sell/fulfillment/v1/order?limit=200", accessToken);
    let synced = 0;
    for (const raw of (Array.isArray(data.orders) ? data.orders : []) as Array<Record<string, any>>) {
      const orderId = String(raw.orderId ?? ""); if (!orderId) continue;
      const { data: order } = await admin.schema("private").from("ebay_orders").upsert({
        ebay_account_id: accountId, order_id: orderId, order_status: String(raw.orderFulfillmentStatus ?? raw.orderPaymentStatus ?? "UNKNOWN"),
        buyer_data: { buyer: raw.buyer ?? null, fulfillmentStartInstructions: raw.fulfillmentStartInstructions ?? null },
        pricing_summary: raw.pricingSummary ?? {}, raw_response: raw, updated_at: new Date().toISOString(),
      }, { onConflict: "ebay_account_id,order_id" }).select("id").single();
      for (const line of (Array.isArray(raw.lineItems) ? raw.lineItems : []) as Array<Record<string, any>>) {
        const sku = String(line.sku ?? "");
        const { data: mapping } = await admin.from("ebay_listing_mappings").select("slab_id").eq("ebay_account_id", accountId).eq("sku", sku).maybeSingle();
        const lineId = String(line.lineItemId ?? "");
        await admin.schema("private").from("ebay_order_line_items").upsert({
          order_id: order.id, line_item_id: lineId, slab_id: mapping?.slab_id ?? null, sku,
          listing_id: line.legacyItemId ?? null, quantity: Number(line.quantity ?? 1), line_total: line.lineItemCost ?? null, raw_response: line,
        }, { onConflict: "order_id,line_item_id" });
        const soldCents = moneyCents(line.lineItemCost);
        if (mapping?.slab_id && soldCents !== null) {
          await admin.from("sold_comps").upsert({ slab_id: mapping.slab_id, source: "EBAY_SELLER_ORDER", external_sale_id: `${orderId}:${lineId}`, sold_price_cents: soldCents, currency: String(line.lineItemCost?.currency ?? "USD"), sold_at: raw.creationDate ?? new Date().toISOString(), raw_response: { order_id: orderId, line_item_id: lineId, sku } }, { onConflict: "source,external_sale_id" });
          await admin.from("slabs").update({ inventory_status: "Sold", sold_at: raw.creationDate ?? new Date().toISOString(), sold_price_cents: soldCents }).eq("id", mapping.slab_id);
        }
      }
      synced += 1;
    }
    await admin.from("ebay_accounts").update({ last_synced_at: new Date().toISOString() }).eq("id", accountId);
    return reply({ status: "success", orders_synced: synced, source_label: "Seller’s Completed Sale" });
  }

  if (operation === "fulfillment") {
    const action = String(body.action ?? "ship");
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
    const data = await ebayFetch("/sell/finances/v1/transaction?limit=200", accessToken);
    let synced = 0;
    for (const raw of (Array.isArray(data.transactions) ? data.transactions : []) as Array<Record<string, any>>) {
      const transactionId = String(raw.transactionId ?? ""); if (!transactionId) continue;
      await admin.schema("private").from("ebay_financial_transactions").upsert({
        ebay_account_id: accountId, transaction_id: transactionId, order_id: raw.orderId ?? null,
        transaction_type: String(raw.transactionType ?? "UNKNOWN"), transaction_status: String(raw.transactionStatus ?? "UNKNOWN"),
        amount: raw.amount ?? null, fee_basis_amount: raw.totalFeeBasisAmount ?? null, raw_response: raw,
        occurred_at: raw.transactionDate ?? raw.bookingEntry ?? null,
      }, { onConflict: "ebay_account_id,transaction_id" });
      synced += 1;
    }
    return reply({ status: "success", financial_transactions_synced: synced, note: "Actual fees and payouts are stored privately; unknown enum and CustomCode values are preserved in raw_response." });
  }

  return unavailable(operation, "eBay seller API capability");
}
