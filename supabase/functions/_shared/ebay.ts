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
import { fetchAllOffersForSku, OFFER_MAX_PAGES, type OffersDiscovery } from "./ebay-offers.ts";
import { fetchInventoryItemForSku, type InventoryItemResult } from "./ebay-inventory-item.ts";
import { type PersistenceResult, type PublishExecutorOps, type ReconcileLocalArgs, type ReconcileOps, type StoredIntent } from "./ebay-publish-executor.ts";
import type { VerificationMethod } from "./ebay-provider-state-engine.ts";
import { type ListingDeps, routeListingWithToken } from "./ebay-listing-handler.ts";
import { fetchAllEbayOrders } from "./ebay-orders-pagination.ts";
import { fetchAllEbayFinanceTransactions } from "./ebay-finances-pagination.ts";
import { runFinanceSync, runOrderSync, type SyncHandlerDeps } from "./ebay-sync-handler.ts";
import type { SyncResult } from "./ebay-sync-orchestrator.ts";
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

// The second provider READ: getInventoryItem. The module owns the AbortController
// timeout (it aborts the underlying request on timeout), so the wrapper just binds
// the real fetch and forwards the module's abort signal to it.
function discoverInventoryItem(accessToken: string, sku: string): Promise<InventoryItemResult> {
  return fetchInventoryItemForSku({
    fetchImpl: (url, init) => fetch(url, init as RequestInit),
    apiOrigin: new URL(API).origin,
    accessToken,
    sku,
  });
}

// SHA-256 of a stored image object's bytes — stable LOCAL image evidence for the
// manifest/fingerprint (never a signed URL, which changes on every request).
async function hashStorageObject(admin: AdminClient, path: string): Promise<string | null> {
  const { data, error } = await admin.storage.from("slab-images").download(path);
  if (error || !data) return null;
  const buf = new Uint8Array(await data.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}


// Checked single-row intent update → structured PersistenceResult (no Supabase
// error AND exactly one affected row; a concurrent delete/zero-row update never
// looks successful, and the failure MODE is distinguishable).
async function checkedIntentUpdate(admin: AdminClient, intentId: string, patch: Record<string, unknown>): Promise<PersistenceResult> {
  const { data, error } = await admin.from("ebay_listing_intents").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", intentId).select("id");
  if (error) return { ok: false, errorCode: "intent_update_failed" };
  if (!Array.isArray(data) || data.length !== 1) return { ok: false, errorCode: "intent_row_count_mismatch" };
  return { ok: true };
}
const recordStatusP = (admin: AdminClient, intentId: string, status: string, lastError: string): Promise<PersistenceResult> =>
  checkedIntentUpdate(admin, intentId, { status, last_error: lastError });

// Fence a long publish: prove THIS caller still holds its lease and extend it.
// A false return means the lease was lost/superseded — abort before any mutation.
async function assertLeaseHeld(admin: AdminClient, accountId: string, sku: string, token: string): Promise<boolean> {
  const { data, error } = await admin.rpc("ebay_publish_lease_assert_and_extend", { p_account_id: accountId, p_sku: sku, p_token: token, p_ttl_seconds: 120 });
  if (error) return false;
  return (data as { held?: boolean } | null)?.held === true;
}

// Load the durable listing intent (with its snapshot + honest image-evidence
// columns) for the executor.
async function loadStoredIntent(admin: AdminClient, accountId: string, sku: string): Promise<{ ok: true; intent: StoredIntent | null } | { ok: false }> {
  const { data, error } = await admin.from("ebay_listing_intents").select("id, status, offer_id, listing_id, fingerprint, fingerprint_version, intended_state, image_manifest, images_submitted_at, image_verification_method, provider_image_evidence, updated_at").eq("ebay_account_id", accountId).eq("sku", sku).maybeSingle();
  if (error) return { ok: false };
  const row = data as Record<string, unknown> | null;
  const intent: StoredIntent | null = row
    ? {
        id: String(row.id), status: String(row.status),
        fingerprint: (row.fingerprint as string | null) ?? null, fingerprintVersion: (row.fingerprint_version as number | null) ?? null,
        offerId: (row.offer_id as string | null) ?? null, listingId: (row.listing_id as string | null) ?? null,
        intendedState: row.intended_state, imageManifest: row.image_manifest,
        imagesSubmittedAt: (row.images_submitted_at as string | null) ?? null,
        verificationMethod: (row.image_verification_method as VerificationMethod | null) ?? null,
        providerImageEvidence: (row.provider_image_evidence as { method?: string; offer_id?: string; listing_id?: string | null } | null) ?? null,
        updatedAt: (row.updated_at as string | null) ?? null,
      }
    : null;
  return { ok: true, intent };
}

// ATOMIC local reconciliation via the transactional RPC → PersistenceResult. The
// RPC proves identity + fingerprint + (for reconcile) the expected version under a
// row lock, then writes the mapping AND the intent in ONE transaction.
async function reconcileLocalRpc(admin: AdminClient, ctx: { accountId: string; slabId: string; sku: string; currency: string }, args: ReconcileLocalArgs): Promise<PersistenceResult> {
  const { data, error } = await admin.rpc("ebay_listing_reconcile_local", {
    p_account_id: ctx.accountId, p_slab_id: ctx.slabId, p_sku: ctx.sku, p_intent_id: args.intentId,
    p_offer_id: args.offerId, p_listing_id: args.listingId ?? "", p_listing_status: args.listingStatus,
    p_asking_price_cents: args.askingPriceCents, p_currency: ctx.currency,
    p_expected_fingerprint: args.fingerprint, p_expected_fingerprint_version: args.fingerprintVersion,
    p_expected_status: args.expectedStatus ?? null, p_expected_offer_id: args.expectedOfferId ?? null,
    p_expected_listing_id: args.expectedListingId ?? null, p_expected_updated_at: args.expectedUpdatedAt ?? null,
  });
  if (error) return { ok: false, errorCode: "reconcile_rpc_failed" };
  return (data as { ok?: boolean } | null)?.ok === true ? { ok: true } : { ok: false, errorCode: "reconcile_rpc_failed" };
}

// Production bindings for the paginated order/finance sync orchestrator. Every
// provider read is fail-closed + paginated; every DB write goes through a checked
// RPC; the single-flight lease + durable sync state live in service-role-only RPCs.
function realSyncDeps(admin: AdminClient): SyncHandlerDeps {
  const ordersOrigin = new URL(API).origin;
  const financeOrigin = new URL(ebayApizBase(MODE)).origin;
  return {
    fetchOrders: (accessToken, query, beforePageFetch) => fetchAllEbayOrders({ fetchImpl: (url, init) => fetch(url, init as RequestInit), apiOrigin: ordersOrigin, accessToken, query, beforePageFetch }),
    fetchFinances: (accessToken, query, beforePageFetch) => fetchAllEbayFinanceTransactions({ fetchImpl: (url, init) => fetch(url, init as RequestInit), apiOrigin: financeOrigin, accessToken, query, beforePageFetch }),
    resolveOrderMappings: async (accountId, skus) => {
      const { data, error } = await admin.from("ebay_listing_mappings").select("sku, slab_id").eq("ebay_account_id", accountId).in("sku", skus);
      if (error) return { ok: false };
      const bySku = new Map<string, string>();
      for (const m of (data ?? []) as Array<{ sku: string; slab_id: string | null }>) { if (m.sku && m.slab_id) bySku.set(m.sku, m.slab_id); }
      return { ok: true, bySku };
    },
    persistOrders: async (accountId, shaped) => {
      const { data, error } = await admin.rpc("ebay_orders_persist", { p_account_id: accountId, p_orders: shaped });
      if (error) return { ok: false };
      const p = (data && typeof data === "object" ? data : {}) as { line_items?: number; confirmed_order_total?: number; confirmed_line_total?: number };
      return { ok: true, durableTotal: p.confirmed_order_total ?? null, durableLines: p.confirmed_line_total ?? null, persisted: p.line_items ?? 0 };
    },
    persistFinances: async (accountId, shaped) => {
      const { data, error } = await admin.rpc("ebay_finance_transactions_apply", { p_account_id: accountId, p_transactions: shaped });
      if (error) return { ok: false };
      const r = (data && typeof data === "object" ? data : {}) as { transactions?: number; total?: number };
      return { ok: true, durableTotal: r.total ?? null, persisted: r.transactions ?? 0 };
    },
    leaseAcquire: async (accountId, resource, token) => {
      const a = await admin.rpc("ebay_sync_lease_acquire", { p_account_id: accountId, p_resource_type: resource, p_token: token, p_ttl_seconds: 300 });
      if (a.error) return { acquired: false, error: true };
      return { acquired: (a.data as { acquired?: boolean } | null)?.acquired === true, error: false };
    },
    leaseAssert: async (accountId, resource, token) => {
      const a = await admin.rpc("ebay_sync_lease_assert_and_extend", { p_account_id: accountId, p_resource_type: resource, p_token: token, p_ttl_seconds: 300 });
      if (a.error) return false;
      return (a.data as { held?: boolean } | null)?.held === true;
    },
    leaseRelease: async (accountId, resource, token) => {
      const r = await admin.rpc("ebay_sync_lease_release", { p_account_id: accountId, p_resource_type: resource, p_token: token });
      if (r.error) return { released: false };
      return { released: (r.data as { released?: boolean } | null)?.released === true };
    },
    syncBegin: async (accountId, resource, token) => {
      const { data, error } = await admin.rpc("ebay_sync_state_load", { p_account_id: accountId, p_resource_type: resource, p_lease_token: token });
      if (error) return { ok: false, errorCode: "sync_begin_failed" };
      const d = (data as { ok?: boolean; run_id?: string; high_watermark_at?: string | null; error_code?: string } | null);
      if (d?.ok !== true || !d.run_id) return { ok: false, errorCode: d?.error_code ?? "sync_begin_failed" };
      return { ok: true, runId: d.run_id, highWatermarkAt: d.high_watermark_at ?? null };
    },
    syncComplete: async (accountId, resource, token, args) => {
      const { data, error } = await admin.rpc("ebay_sync_complete", { p_account_id: accountId, p_resource_type: resource, p_run_id: args.runId, p_lease_token: token, p_high_watermark_at: args.highWatermarkAt, p_overlap_start_at: args.overlapStartAt, p_pages: args.pagesFetched, p_records_fetched: args.recordsFetched, p_records_persisted: args.recordsPersisted, p_durable_total: args.durableTotal, p_latency_ms: Math.max(0, Math.round(args.latencyMs)) });
      if (error) return { ok: false, errorCode: "sync_complete_rpc_failed" };
      const d = (data as { ok?: boolean; error_code?: string } | null);
      return d?.ok === true ? { ok: true } : { ok: false, errorCode: d?.error_code ?? "sync_complete_failed" };
    },
    syncFail: async (accountId, resource, runId, errorCode) => {
      const { data, error } = await admin.rpc("ebay_sync_state_fail", { p_account_id: accountId, p_resource_type: resource, p_run_id: runId, p_error_code: errorCode });
      return { ok: !error && (data as { ok?: boolean } | null)?.ok === true };
    },
    recordApiRun: async (accountId, operation, status, errorCode) => ({ ok: await recordApiRun(admin, accountId, operation, status, 0, errorCode) }),
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
  };
}

// Map a SyncResult to a response body.
function syncBody(r: SyncResult, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const b: Record<string, unknown> = { status: r.status };
  if (r.errorCode) b.error_code = r.errorCode;
  if (r.pagesFetched !== undefined) b.pages_fetched = r.pagesFetched;
  if (r.recordsFetched !== undefined) b.records_fetched = r.recordsFetched;
  if (r.recordsPersisted !== undefined) b.records_persisted = r.recordsPersisted;
  if (r.durableTotal !== undefined) b.durable_total = r.durableTotal;
  if (r.durableSecondary !== undefined && r.durableSecondary !== null) b.durable_secondary = r.durableSecondary;
  if (r.deduplicated !== undefined) b.deduplicated = r.deduplicated;
  if (r.highWatermarkAt !== undefined) b.high_watermark_at = r.highWatermarkAt;
  if (r.recoveryUnpersisted) b.recovery_unpersisted = true;
  return { ...b, ...extra };
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

// ── Injected adapter dependencies ───────────────────────────────────────────
// handleEbay routes ALL listing-critical auth/I/O through this interface, so the
// SAME exported handler the Edge entrypoints call is executable in tests with
// mocked dependencies (src/test/ebay/handler-adapter.test.ts). realDeps() binds the
// production implementations. Each dependency is a DOMAIN operation, so tests do
// NOT fragilely stub the Supabase client or global modules.
// The listing-critical domain operations live in `ListingDeps` (ebay-listing-handler);
// the full EbayDeps adds the shared auth/admin/token/clock the rest of handleEbay uses.
export interface EbayDeps extends ListingDeps {
  verifyAdmin: (req: Request) => Promise<{ ok: boolean; userId: string | null }>;
  makeAdmin: () => AdminClient;
  now: () => number;
}

function realDeps(): EbayDeps {
  let cached: AdminClient | null = null;
  const admin = () => (cached ??= makeAdmin());
  return {
    verifyAdmin: async (req) => { const a = await isCallerAdmin(req); return { ok: !!a.user && !!a.isAdmin, userId: a.user?.id ?? null }; },
    flagEnabled,
    makeAdmin,
    loadAccessToken: async (accountId) => { try { return { ok: true, token: await userAccessToken(admin(), accountId) }; } catch { return { ok: false }; } },
    loadSlabForListing: async (slabId) => {
      const { data, error } = await admin().from("slabs").select("inventory_number, front_image_path, back_image_path").eq("id", slabId).maybeSingle();
      if (error) return { ok: false };
      const row = data as Record<string, unknown> | null;
      return { ok: true, slab: row ? { inventoryNumber: Number(row.inventory_number), frontImagePath: (row.front_image_path as string | null) ?? null, backImagePath: (row.back_image_path as string | null) ?? null } : null };
    },
    verifyListingOwnership: async (a) => {
      const [locOwn, fulOwn, payOwn, retOwn] = await Promise.all([
        admin().from("ebay_inventory_locations").select("merchant_location_key, status").eq("ebay_account_id", a.accountId).eq("merchant_location_key", a.merchantLocationKey).maybeSingle(),
        admin().from("ebay_business_policies").select("policy_id, marketplace_id").eq("ebay_account_id", a.accountId).eq("policy_id", a.fulfillmentPolicyId).eq("policy_type", "fulfillment").maybeSingle(),
        admin().from("ebay_business_policies").select("policy_id, marketplace_id").eq("ebay_account_id", a.accountId).eq("policy_id", a.paymentPolicyId).eq("policy_type", "payment").maybeSingle(),
        admin().from("ebay_business_policies").select("policy_id, marketplace_id").eq("ebay_account_id", a.accountId).eq("policy_id", a.returnPolicyId).eq("policy_type", "return").maybeSingle(),
      ]);
      if (locOwn.error || fulOwn.error || payOwn.error || retOwn.error) return { ok: false, errorCode: "ownership_check_failed", httpStatus: 500 };
      if (!locOwn.data) return { ok: false, errorCode: "unknown_location", httpStatus: 400 };
      const locStatus = String((locOwn.data as Record<string, unknown>).status ?? "").toUpperCase();
      if (locStatus && locStatus !== "ENABLED") return { ok: false, errorCode: "location_not_enabled", httpStatus: 400 };
      if (!fulOwn.data) return { ok: false, errorCode: "unknown_fulfillment_policy", httpStatus: 400 };
      if (!payOwn.data) return { ok: false, errorCode: "unknown_payment_policy", httpStatus: 400 };
      if (!retOwn.data) return { ok: false, errorCode: "unknown_return_policy", httpStatus: 400 };
      const mismatch = [fulOwn, payOwn, retOwn].some((p) => { const m = String((p.data as Record<string, unknown>).marketplace_id ?? ""); return m && m !== a.marketplaceId; });
      if (mismatch) return { ok: false, errorCode: "policy_marketplace_mismatch", httpStatus: 400 };
      return { ok: true };
    },
    signImageUrl: async (path) => { const { data, error } = await admin().storage.from("slab-images").createSignedUrl(path, 3600); return error || !data?.signedUrl ? null : data.signedUrl; },
    hashImage: (path) => hashStorageObject(admin(), path),
    leaseAcquire: async (accountId, sku, token) => {
      const acq = await admin().rpc("ebay_publish_lease_acquire", { p_account_id: accountId, p_sku: sku, p_token: token, p_ttl_seconds: 120 });
      if (acq.error) return { acquired: false, error: true };
      return { acquired: (acq.data as { acquired?: boolean } | null)?.acquired === true, error: false };
    },
    makePublishOps: (b) => {
      const a = admin();
      return {
        loadIntent: () => loadStoredIntent(a, b.accountId, b.sku),
        writePreparing: async (snap) => {
          const { data, error } = await a.from("ebay_listing_intents").upsert({ ebay_account_id: b.accountId, slab_id: b.slabId, sku: b.sku, fingerprint: snap.fingerprint, fingerprint_version: snap.fingerprintVersion, intended_state: snap.intendedState, image_manifest: snap.imageManifest, status: "preparing", last_error: null, images_submitted_at: null, image_verification_method: null, provider_image_evidence: null, updated_at: new Date().toISOString() }, { onConflict: "ebay_account_id,sku" }).select("id");
          if (error || !Array.isArray(data) || data.length !== 1) return { ok: false };
          return { ok: true, intentId: String((data[0] as { id: string }).id) };
        },
        recordStatus: (id, status, err) => recordStatusP(a, id, status, err),
        recordOfferCreated: (id, offerId) => checkedIntentUpdate(a, id, { status: "offer_created", offer_id: offerId, images_submitted_at: new Date().toISOString(), image_verification_method: "submitted_only", provider_image_evidence: { method: "submitted_only", offer_id: offerId }, last_error: `offer:${offerId}` }),
        reconcileLocal: (args) => reconcileLocalRpc(a, { accountId: b.accountId, slabId: b.slabId, sku: b.sku, currency: b.currency }, args),
        discoverOffers: (s) => discoverOffers(b.accessToken, s),
        fetchInventoryItem: (s) => discoverInventoryItem(b.accessToken, s),
        assertLease: () => assertLeaseHeld(a, b.accountId, b.sku, b.leaseToken),
        putInventoryItem: async () => { try { await ebayFetch(`/sell/inventory/v1/inventory_item/${encodeURIComponent(b.sku)}`, b.accessToken, { method: "PUT", body: JSON.stringify(b.inventoryPayload) }); return { ok: true }; } catch { return { ok: false }; } },
        createOffer: async () => { try { const offer = await ebayFetch("/sell/inventory/v1/offer", b.accessToken, { method: "POST", body: JSON.stringify(b.offerPayload) }); return { ok: true, offerId: offer.offerId ? String(offer.offerId) : null }; } catch { return { ok: false, offerId: null }; } },
        publishOffer: async (offerId) => { try { const p = await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, b.accessToken, { method: "POST", body: "{}" }); return { ok: true, listingId: p.listingId ? String(p.listingId) : null }; } catch { return { ok: false, listingId: null }; } },
        recordApiRun: async (op, status, code) => (await recordApiRun(a, b.accountId, op, status, 0, code)) ? { ok: true } : { ok: false, errorCode: "api_run_persist_failed" },
        releaseLease: async () => { const rel = await a.rpc("ebay_publish_lease_release", { p_account_id: b.accountId, p_sku: b.sku, p_token: b.leaseToken }); if (rel.error) return { released: false }; return { released: (rel.data as { released?: boolean } | null)?.released === true }; },
      };
    },
    makeReconcileOps: (b) => {
      const a = admin();
      return {
        loadIntent: () => loadStoredIntent(a, b.accountId, b.sku),
        recordStatus: (id, status, err) => recordStatusP(a, id, status, err),
        reconcileLocal: (args) => reconcileLocalRpc(a, { accountId: b.accountId, slabId: b.slabId, sku: b.sku, currency: b.currency }, args),
        recordApiRun: async (op, status, code) => (await recordApiRun(a, b.accountId, op, status, 0, code)) ? { ok: true } : { ok: false, errorCode: "api_run_persist_failed" },
        discoverOffers: (s) => discoverOffers(b.accessToken, s),
        fetchInventoryItem: (s) => discoverInventoryItem(b.accessToken, s),
      };
    },
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
  };
}

export async function handleEbay(req: Request, operation: Operation, deps: EbayDeps = realDeps()): Promise<Response> {
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

  const authv = await deps.verifyAdmin(req);
  if (!authv.ok) return unauthorizedResponse(corsHeaders);
  const body = await parseBody(req);

  if (operation === "oauth_start") {
    if (!RU_NAME || !REDIRECT_URI) return unavailable(operation, "OAuth authorization-code flow");
    const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const admin = makeAdmin();
    // Single-flight: atomically expire this admin's prior unconsumed states and
    // create exactly one, under an advisory lock scoped to the requester.
    const { error: stateError } = await admin.rpc("ebay_oauth_state_create_single_flight", {
      p_state_hash: await sha256(state),
      p_requested_by: authv.userId!,
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
  // The service-role admin client is used by the non-listing seller ops; the
  // listing ops (list_item / reconcile) reach the DB only through injected deps.
  // The seller access token is loaded PER-OP (not up front): a disabled list_item
  // PUBLISH must never touch the OAuth/credential path, so its flag gate runs
  // before the token load (inside routeListingWithToken).
  const admin = deps.makeAdmin();

  if (operation === "list_item") {
    const marketplaceId = String(body.marketplace_id ?? "EBAY_US");
    const categoryId = String(body.category_id ?? "");
    if (body.confirmation !== "PUBLISH") {
      // Preparation is READ-ONLY (no mutation) → loading the token here is fine.
      const ptok = await deps.loadAccessToken(accountId);
      if (!ptok.ok) return unavailable(operation, "Connected eBay account");
      const accessToken = ptok.token;
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
    // list_item PUBLISH is routed by the injected-deps listing handler, which gates
    // the listing flag BEFORE loading the seller token (a disabled publish makes
    // zero credential/provider calls). A confirmation phrase can never bypass it.
    const pub = await routeListingWithToken("list_item", body, accountId, marketplaceId, categoryId, deps);
    return reply(pub.body, pub.httpStatus);
  }

  if (operation === "revise_item" && body.action === "reconcile") {
    const rec = await routeListingWithToken("reconcile", body, accountId, "", "", deps);
    return reply(rec.body, rec.httpStatus);
  }

  // Remaining seller ops load the token now (their flag gates follow).
  const tokShared = await deps.loadAccessToken(accountId);
  if (!tokShared.ok) return unavailable(operation, "Connected eBay account");
  const accessToken = tokShared.token;

  if (operation === "revise_item") {
    if (!deps.flagEnabled(MUTATION_FLAGS.listing)) return mutationDisabled("revise_item", "listing");
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
    if (!deps.flagEnabled(MUTATION_FLAGS.listing)) return mutationDisabled("end_item", "listing");
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
      if (!deps.flagEnabled(MUTATION_FLAGS.applySales)) return mutationDisabled("order_sync", "apply-sales");
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

    // DEFAULT: non-destructive, COMPLETE-pagination inbound sync via the shared
    // watermark orchestrator (single-flight lease → fail-closed paginated fetch →
    // idempotent persist → durable watermark advance). It NEVER touches slab
    // inventory or sold_comps and NEVER calls APPLY_SALES. Proposed sales are
    // derived ONLY from successfully persisted lines.
    let proposedSales: unknown[] = [];
    const r = await runOrderSync(accountId, accessToken, { ...realSyncDeps(admin), collectProposedSales: (s) => { proposedSales = s; } });
    if (r.status === "success") {
      return reply(syncBody(r, { mode: "synced", processed_orders: r.recordsFetched ?? 0, processed_lines: r.recordsPersisted ?? 0, confirmed_order_total: r.durableTotal ?? 0, confirmed_line_total: r.durableSecondary ?? 0, proposed_sales: proposedSales, proposed_sale_count: proposedSales.length, orders_synced: r.durableTotal ?? 0, source_label: "Seller’s Completed Sale", message: `${r.recordsFetched ?? 0} fetched · ${r.recordsPersisted ?? 0} persisted · ${r.deduplicated ?? 0} deduped · ${proposedSales.length} proposed sale(s).` }));
    }
    return reply(syncBody(r), r.httpStatus);
  }

  if (operation === "fulfillment") {
    const action = String(body.action ?? "ship");
    // Ship is a fulfillment mutation; refund moves money (financial mutation).
    if (action === "refund" && !deps.flagEnabled(MUTATION_FLAGS.financial)) return mutationDisabled("fulfillment", "financial");
    if (action !== "refund" && !deps.flagEnabled(MUTATION_FLAGS.fulfillment)) return mutationDisabled("fulfillment", "fulfillment");
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
    // Inbound finance sync is READ-only (recording fees/payouts). COMPLETE-pagination
    // via the shared watermark orchestrator (apiz gateway). It NEVER issues a refund,
    // creates a payout, moves money, or alters a slab/sold comp. Unknown enum /
    // CustomCode values are preserved; durable totals track unique rows.
    const r = await runFinanceSync(accountId, accessToken, realSyncDeps(admin));
    if (r.status === "success") {
      return reply(syncBody(r, { financial_transactions_synced: r.recordsPersisted ?? 0, financial_transactions_total: r.durableTotal ?? null, note: "Fees/payouts stored privately; the watermark reflects durable unique rows. Unknown enum/CustomCode values preserved." }));
    }
    return reply(syncBody(r), r.httpStatus);
  }

  return unavailable(operation, "eBay seller API capability");
}
