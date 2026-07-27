# V2 Edge Function Contracts

- **Generated:** 2026-07-27
- **Source commit:** `ba3953fdb68c31435c7dac732f67d8d53aa2adcb`
- **Status:** Generated documentation of **existing behavior** as read from the code at the commit above. This is **not a change proposal**. Where behavior is ambiguous or surprising, it is flagged, not "fixed".

Scope: all 18 Edge Functions under `supabase/functions/`, their `verify_jwt` settings from `supabase/config.toml`, and the frontend call sites under `src/lib/`. Env var **names** are listed where relevant; no secret values appear anywhere in this document.

---

## Summary table

| Function | verify_jwt | Caller class | Auth inside function | Main side effects |
|---|---|---|---|---|
| `analyze-slab` | true | Browser (admin) | Admin JWT (`is_admin` RPC) | OpenAI Responses API; insert `ai_analysis_runs`, `ai_field_evidence` |
| `scan-card` | true | Browser (customer) | Customer JWT + email verified + active profile | OpenAI Responses API; `card-scans` storage; `card_scans`, `cards`, `card_scan_reviews`, `audit_log` |
| `pricecharting-search` | true | Browser (admin) | Admin JWT | PriceCharting API (read-only); DB rate-limit reservation |
| `pricecharting-marketplace` | true | Browser (admin) + internal | Admin JWT **or** service-role bearer (sync_all only) | PriceCharting Marketplace API; `pricecharting_sync_runs`, `pricecharting_offers` (via RPC), settings |
| `pricecharting-sync` | true | Browser (admin, legacy) | Admin JWT | Proxies `pricecharting-marketplace` `sync_all` |
| `marketplace-scheduler` | true | Internal / scheduler | Bearer must equal service-role key | Proxies `pricecharting-marketplace` `sync_all` |
| `market-intelligence` | *(not in config.toml — platform default `true`)* | Browser (any authed user) | User JWT; RLS-scoped reads | PriceCharting + eBay Browse APIs (read-only); no DB writes |
| `ebay-oauth-start` | true | Browser (admin) | Admin JWT | `private.ebay_oauth_states` via RPC (single-flight state) |
| `ebay-oauth-callback` | **false** | Browser redirect from eBay (no JWT) | Single-use hashed OAuth `state` + code exchange | eBay token exchange; `ebay_accounts`; encrypted credential RPCs |
| `ebay-account-sync` | true | Browser (admin) | Admin JWT | eBay Sell/Identity reads; replace RPCs for locations/policies; `ebay_accounts`, `ebay_sync_cursors`, `ebay_api_runs` |
| `ebay-reference-search` | true | Browser (admin) | Admin JWT | eBay Browse API (app token); no DB writes |
| `ebay-list-item` | true | Browser (admin) | Admin JWT + `EBAY_LISTING_MUTATIONS_ENABLED` + `PUBLISH` phrase | eBay Inventory/Offer publish; `ebay_listing_intents`, `ebay_listing_mappings`, publish leases; reads `slab-images` |
| `ebay-revise-item` | true | Browser (admin) | Admin JWT + listing flag + `REVISE` phrase (reconcile path unflagged) | eBay offer PUT / provider reads; `ebay_listing_mappings`, `ebay_listing_intents` |
| `ebay-end-item` | true | Browser (admin) | Admin JWT + listing flag + `END` phrase | eBay offer withdraw; `ebay_listing_mappings` |
| `ebay-order-sync` | true | Browser (admin) | Admin JWT (+ apply-sales flag + `APPLY_SALES` phrase for that mode) | eBay Fulfillment getOrders; `private.ebay_orders`/`ebay_order_line_items` via RPC; sync leases/state; apply-sales via RPC |
| `ebay-fulfillment` | true | Browser (admin) | Admin JWT + fulfillment/financial flag + `SHIP`/`REFUND` phrase | eBay shipping-fulfillment / issue_refund (no local DB writes) |
| `ebay-finances-sync` | true | Browser (admin) | Admin JWT | eBay Finances API (apiz); `private.ebay_financial_transactions` via RPC; sync leases/state |
| `ebay-notification-handler` | **false** | Webhook (eBay) | ECDSA signature over raw body + challenge token | `ebay_notifications` replay-safe inbox |

---

## Shared conventions

### CORS
All functions use `_shared/cors.ts`: `Access-Control-Allow-Origin: *`, allowed headers `authorization, x-client-info, apikey, content-type`. `OPTIONS` preflight returns 200/204 with these headers.

### Authentication helpers (`_shared/auth.ts`)
- `getCallerUser(req)` — verifies the `Authorization: Bearer <JWT>` with `supabase.auth.getUser`; returns the user or `null`.
- `isCallerAdmin(req)` — `getCallerUser` + service-role RPC `is_admin(_user_id)`. Any RPC error is treated as **not admin** (fail closed).
- `unauthorizedResponse` → `401 { "error": "Unauthorized" }`; `forbiddenResponse` → `403 { "error": "<message>" }`.

Note: `verify_jwt = true` means the Supabase gateway rejects requests without a *valid* JWT before the function runs; the in-function checks above are the authorization layer on top of that.

### Error envelope + frontend normalizer
Handlers return a structured JSON error envelope, typically:

```ts
{ status: "error", error_code: string, message?: string, retryable?: boolean, ... }
```

The frontend normalizer `src/lib/slabs/function-error.ts` (`normalizeFunctionInvokeError`) reads the Edge Function `Response` kept in Supabase's `FunctionsHttpError.context`, parses only the JSON body, and returns:

```ts
type StructuredFunctionError = Record<string, unknown> & {
  status: string;        // body.status or "error"
  message: string;       // body.message or a generic fallback
  error_code?: string;
  http_status?: number;  // the HTTP status of the edge response
};
```

It deliberately never exposes headers, tokens, or raw provider bodies.

### eBay mutation kill switches (`_shared/ebay-mutation-flags.ts`)
Server-only env flags; a mutation runs **only** when the flag value is exactly `"true"` (trimmed, case-insensitive). Defaults are OFF. A client confirmation phrase can never bypass a disabled flag.

| Flag env var | Gates |
|---|---|
| `EBAY_LISTING_MUTATIONS_ENABLED` | publish (`list_item`), `revise_item`, `end_item` |
| `EBAY_FULFILLMENT_MUTATIONS_ENABLED` | `fulfillment` action `ship` |
| `EBAY_FINANCIAL_MUTATIONS_ENABLED` | `fulfillment` action `refund` |
| `EBAY_APPLY_SALES_ENABLED` | `order_sync` `APPLY_SALES` mode |

Disabled mutation → `403 { status: "mutation_disabled", operation, kind, message }`.

### Confirmation phrases
Consequential eBay mutations additionally require a typed phrase in the body (`confirmation`): `PUBLISH`, `REVISE`, `END`, `SHIP`, `REFUND`, `APPLY_SALES`. Missing/incorrect phrase → `409 { status: "confirmation_required", confirmation_phrase, message }`.

### Common eBay env vars (names only)
`EBAY_ENVIRONMENT` (`sandbox`/production), `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_REDIRECT_URI`, `EBAY_RU_NAME` (or `EBAY_RUNAME`), `EBAY_APP_BASE_URL`, `EBAY_TOKEN_ENCRYPTION_KEY`, `EBAY_NOTIFICATION_VERIFICATION_TOKEN`, `EBAY_NOTIFICATION_ENDPOINT`. If client id/secret are absent, every eBay operation returns `409 { status: "unavailable", operation, capability, required_configuration: [...] }` (env var names only, never values).

---

## 1. `analyze-slab`

| | |
|---|---|
| **verify_jwt** | `true` |
| **Methods** | `POST` (JSON). `OPTIONS` preflight. Other methods → `405 INVALID_PARAMETER`. |
| **Classification** | Browser-callable, **admin only** |
| **Intended V2 UI flow** | Slab intake ("New Slab") AI identification — `src/lib/slabs/data.ts` `analyzeSlab()` from `src/pages/slabs/NewSlab.tsx` |

**Authentication / authorization:** JWT required (gateway) → `isCallerAdmin`; non-admin → `403 NOT_AUTHORIZED`. Global daily quota `consumeDailyQuota("analyze-slab-openai", ANALYZE_DAILY_LIMIT default 200)` — **fails open** on DB error (documented as an intentional spend-ceiling, not a hard limit) → `429 QUOTA_EXCEEDED` when exhausted.

**Request body** (`AnalyzeInput`, `src/server/analyze-slab/handler.ts`):

```ts
{
  front_image_base64: string;   // required
  front_mime: string;           // required
  back_image_base64?: string;
  back_mime?: string;
  variants?: Array<{ label: string; image_base64: string; mime: string }>; // deterministic derivatives
}
```

The function forces `strict_multi_pass: true` (main identity pass + collector-number reread + certification-number reread + critical-identity pass, each with its own strict JSON schema).

**Success response (200):** the handler's success body (per-field evidence objects with `value`, `normalized_value`, `confidence`, `source`, `bounding_box`, `readability`, `alternatives`; plus `warnings`, `label_matches_card`, `overall_confidence`) augmented with:

```ts
{
  analysis_version: "gcv-vision-2.0", model, provider: "OPENAI",
  analysis_run_id: string | null, request_ids: string[], latency_ms: number,
  overall_status: "PROPOSED" | "NEEDS_REVIEW",
  images_evaluated: string[], identity_conflicts: string[],
  required_user_actions: string[], search_queries: string[]
}
```

**Errors:** `401`; `403 NOT_AUTHORIZED`; `502 NOT_CONFIGURED` (no `OPENAI_API_KEY`); `429 QUOTA_EXCEEDED`; `400 INVALID_PARAMETER` (bad JSON); `502 OPENAI_ANALYSIS_ERROR` (catch-all — "failed safely; no fields were verified").

**Idempotency / retry:** none at the request level — every call creates a fresh analysis run. Internally the OpenAI call retries up to 4 attempts on HTTP 429/5xx with jittered exponential backoff (cap 4 s).

**Side effects:** OpenAI Responses API (`api.openai.com/v1/responses`, model `OPENAI_ANALYZE_MODEL` default `gpt-5.6-terra`, `store: false`). Service-role inserts into `ai_analysis_runs` (telemetry + normalized result) and `ai_field_evidence` (per-field rows; `image_id`/`derivative_id` deliberately left `null` — evidence is linked to real image rows later by the save/link RPC `link_ai_analysis_run`, invoked from the frontend). No storage writes.

**Tables / storage:** `ai_analysis_runs`, `ai_field_evidence`. No bucket access.

**Security notes:** admin-gated vision spend; OpenAI key never leaves the server; catch-all error hides internals. Quota fail-open is deliberate but means a DB outage removes the spend ceiling.

---

## 2. `scan-card`

| | |
|---|---|
| **verify_jwt** | `true` |
| **Methods** | `POST` only (`405 METHOD_NOT_ALLOWED` otherwise). Two content types: `multipart/form-data` (capture) and JSON (actions). |
| **Classification** | Browser-callable, **customer** (the only customer-facing function) |
| **Intended V2 UI flow** | Live camera raw-card scanner + raw-card inventory — `src/lib/cards/api.ts` from `src/components/cards/CardScanner.tsx`. In production the browser calls same-origin `/api/scan-card`, a Vercel rewrite to this function (see `vercel.json`); local dev calls `functions.invoke` directly. |

**Authentication / authorization:** JWT required → `getCallerUser`; then **email must be confirmed** (`403` "Verify your email…") and `customer_profiles.account_status` must be `active` (`403`; lookup failure → `503 ACCOUNT_LOOKUP_FAILED`). All data access is owner-scoped in code: every query filters `created_by = <caller uid>` (the function uses the service-role client, so these explicit filters are the authorization).

**Request shapes:**

*Capture (multipart):* field `image` = JPEG file, 1 byte–10 MB, magic-byte checked. Per-user daily quota `consumeUserDailyQuota(userId, "scan-card-openai", SCAN_DAILY_LIMIT default 300)` — **fails closed** → `429 QUOTA_EXCEEDED`.

*Actions (JSON):*

```ts
| { action: "card_summary" }
| { action: "list_cards"; inventory_status?: "active" | "archived" }
| { action: "get_card"; card_id: string }
| { action: "update_card"; card_id: string; card_name: string; set_name: string;
    card_number: string; rarity?: string; condition_notes?: string; allow_duplicate?: boolean }
| { action: "archive_card" | "restore_card"; card_id: string }
| { action: "list_reviews" }
| { action: "skip"; scan_id: string }
| { action: "confirm"; scan_id: string; card_name?: string; set_name?: string;
    card_number?: string; rarity?: string; add_anyway?: boolean }
```

**Responses:** capture → `{ status: "added", scan_id, extraction, card, duplicates: [] }` or `{ status: "needs_review" | "possible_duplicate", scan_id, extraction, duplicates }`. Actions → `{ status: "success", ... }` (`cards`, `card`, `reviews`, counts), `{ status: "skipped" | "added" | "possible_duplicate", ... }`. Errors: `{ status: "error", error_code, message }` with codes `INVALID_MULTIPART`/`IMAGE_REQUIRED` (400), `IMAGE_SIZE` (413), `INVALID_IMAGE` (415), `STORAGE_UPLOAD`/`SCAN_AUDIT`/`ANALYSIS_FAILED`/`NOT_CONFIGURED` (502), `CARD_NOT_FOUND`/`SCAN_NOT_FOUND` (404), `CARD_ID_REQUIRED`/`SCAN_ID_REQUIRED`/`INVALID_CARD`/`INVALID_CORRECTION`/`INVALID_ACTION` (400), `SCAN_CARD_ERROR` (500). `Cache-Control: no-store` on every response.

**Idempotency / retry:** `confirm` is idempotent — if a card already exists for the `source_scan_id` it returns `added` with the existing card instead of inserting a duplicate. Duplicate detection uses normalized identity columns with explicit `allow_duplicate`/`add_anyway` overrides. Storage upload is `upsert: false`; if the audit row fails, the uploaded object is removed (compensating cleanup). Auto-add threshold: confidence ≥ 0.75 with zero duplicates (`card-scan-core.ts`).

**Side effects:** OpenAI Responses API (model `OPENAI_SCAN_MODEL` ?? `OPENAI_ANALYZE_MODEL` ?? `gpt-5.6-terra`, retry ×4 backoff); storage bucket **`card-scans`** at path `"<userId>/<scanId>.jpg"`; signed URLs (600 s) for thumbnails/images; `audit_log` rows for auto-add/confirm/skip/update/archive/restore.

**Tables / storage:** `card_scans`, `cards`, `card_scan_reviews`, `audit_log`, `customer_profiles` (read); bucket `card-scans`.

**Security notes:** service-role access mitigated by explicit owner filters; JPEG validation + size caps; API-key redaction in error messages (`sk-…` scrubbing); per-user fail-closed quota.

---

## 3. `pricecharting-search`

| | |
|---|---|
| **verify_jwt** | `true` |
| **Methods** | `POST` (JSON); other → `405 INVALID_PARAMETER` |
| **Classification** | Browser-callable, **admin only** |
| **Intended V2 UI flow** | Slab intake product matching + valuation — `priceChartingSearch` / `priceChartingValue` / `priceChartingOfferImage` / `priceChartingLookup` in `src/lib/slabs/data.ts`, used by `PriceChartingPanel.tsx` and `NewSlab.tsx` |

**Authentication / authorization:** admin JWT (`isCallerAdmin`) → `401` / `403 NOT_AUTHORIZED`. This is the **only** place `PRICECHARTING_API_TOKEN` is read; missing token → `502 SUBSCRIPTION_REQUIRED` (config specifics deliberately not revealed).

**Request body** (`SlabSearchInput`, `src/server/pricecharting/handler.ts`):

```ts
{
  action?: "search" | "value" | "offer_image" | "lookup";   // default "search"
  card_name?: string; set?: string; card_number?: string;
  year?: number | string; language?: string; variation?: string;
  grader?: string; grade?: string | number; grade_label?: string;
  product_id?: string;      // required for "value" / "lookup" (or product_url)
  product_url?: string;     // "lookup": id extracted from URL
  canonical_url?: string;   // stored /game/ URL for the page adapter
}
```

**Responses:** `{ statusCode, body }` from the bundled handler. Success bodies are per-action (`action: "search" | "value" | "offer_image" | "lookup"` plus products/tiers/conflicts/offer image). Error envelope:

```ts
{ status: "error", error_code, message, retryable: boolean, details? }
```

HTTP mapping (`httpStatusFor`): `AUTHENTICATION_ERROR`/`SUBSCRIPTION_REQUIRED` → 502; `RATE_LIMITED` → 429; `RATE_LIMIT_RESERVATION_UNAVAILABLE` → 503; `MISSING_PARAMETER`/`INVALID_PARAMETER`/`VALIDATION_ERROR` → 400; `PRODUCT_NOT_FOUND` → 404; `TIMEOUT` → 504; default → 500. Outer catch-all → `500 UNKNOWN_API_ERROR` (never leaks internals/token).

**Idempotency / retry:** read-only; safe to retry. Every network attempt (including library retries) first reserves a **durable DB rate-limit slot** (`reserve_api_request_slot` RPC, bucket `pricecharting`, ≥1 s spacing across all isolates; `_shared/rate-limit.ts`). Reservation failure or >10 s backlog **fails closed** (503, no upstream call).

**Side effects:** PriceCharting API (`www.pricecharting.com`); optional public product-page fetch **only** when `PRICECHARTING_PAGE_ADAPTER_ENABLED` is exactly `"true"` (operator-gated; same reserver; never returns raw HTML). DB: rate-limit reservation rows (`api_rate_limits` via RPC). No content tables written.

**Security notes:** token never logged/returned (guaranteed by handler + catch-all); admin-only so customers can never spend the PriceCharting quota.

---

## 4. `pricecharting-marketplace`

| | |
|---|---|
| **verify_jwt** | `true` |
| **Methods** | `POST` (JSON); other → `405` |
| **Classification** | Browser-callable (admin) **and** internal (service-role, `sync_all` only) |
| **Intended V2 UI flow** | Marketplace offer management — `invokePriceChartingMarketplace` / `syncAllPriceChartingOffers` in `src/lib/slabs/data.ts`, used by `PriceChartingMarketplacePanel.tsx` |

**Authentication / authorization:** if the bearer token **equals** `SUPABASE_SERVICE_ROLE_KEY` the request is treated as an internal service request (admin-equivalent, but restricted to `sync_all` — anything else → `403 NOT_AUTHORIZED "Service requests may only synchronize offers."`). Otherwise admin JWT via `isCallerAdmin` → `401`/`403`. Missing `PRICECHARTING_API_TOKEN` → `502 SUBSCRIPTION_REQUIRED`.

**Request body** (`MarketplaceInput`, `src/server/pricecharting/marketplace-handler.ts`):

```ts
{
  action: "sync_all"                    // batch mode (admin or service)
        | "list" | "details" | "publish" | "edit"
        | "ship" | "feedback" | "end" | "refund";
  slab_id?; offer_id?; seller_id?; status?; product_id?; product_name?; sku?;
  condition_id?; price_min_dollars?; price_max_dollars?; cost_basis_dollars?;
  description?; pristine?; scratch?; stickers?; tear?; writing?; broken?;
  tracking_number?; rating?; comment?;
  confirm?: boolean; confirm_refund?: boolean;   // required by the library for consequential ops
  idempotency_key?: string;
}
```

**`sync_all` behavior:** insert a `pricecharting_sync_runs` row (`trigger_kind: "scheduled"` for service requests, `"manual"` for admins; `created_by` = admin uid or null) → load up to **100** `pricecharting_offers` (excluding `offer_status = 'refunded'`, oldest `last_synced_at` first) → for each, call the marketplace `details` action and apply via RPC `apply_pricecharting_offer_snapshot(p_slab_id, p_snapshot, 'synced')` → finish the run (`success` / `partial` / `failed`, counters, error message) → touch `pricecharting_marketplace_settings.last_synced_at`. Response: `{ status: "success", action: "sync_all", offers_seen, offers_updated, failed }` (200) or `500 SYNC_FAILED`.

**Other actions:** proxied to the bundled marketplace handler. Success → `{ status: "success", action, snapshot }` (or `offers[]` for `list`) where `snapshot` is a `MarketplaceSnapshot` (offer/product ids, status, cents-denominated prices, shipped/refunded/feedback/tracking, lifecycle timestamps). Errors → `{ status: "error", error_code, message, retryable? }` with the same HTTP mapping as `pricecharting-search`; invalid action → `400 INVALID_PARAMETER`. Note: for interactive (non-`sync_all`) calls, **the frontend** applies the returned snapshot itself via the `apply_pricecharting_offer_snapshot` RPC — the function does not persist it.

**Idempotency / retry:** durable 1 req/s reservation before every PriceCharting attempt (fail closed); `idempotency_key` and `confirm`/`confirm_refund` are enforced inside the marketplace library for the write actions; snapshot application is an idempotent upsert-style RPC. `sync_all` has **no lease/single-flight** — concurrent runs create separate `pricecharting_sync_runs` rows (see Ambiguities).

**Side effects:** PriceCharting Marketplace API (list/details/publish/edit/ship/feedback/end/refund — `refund` and `end` are consequential provider mutations); tables `pricecharting_sync_runs`, `pricecharting_offers` + `pricecharting_offer_events` (via RPC), `pricecharting_marketplace_settings`; rate-limit reservations.

---

## 5. `pricecharting-sync`

| | |
|---|---|
| **verify_jwt** | `true` |
| **Methods** | any (only `OPTIONS` special-cased); intended `POST` |
| **Classification** | Browser-callable, **admin only** (legacy/ops entry point — no current `src/` caller) |

**Behavior:** admin JWT check (`401`/`403 "Admin access required."`) then a server-side `fetch` to `.../functions/v1/pricecharting-marketplace` with body `{ action: "sync_all" }`, forwarding the **caller's** `Authorization` header (admin JWT) plus the anon `apikey`. The proxied response body/status is returned verbatim.

**Notes:** request body is ignored. The UI now calls `pricecharting-marketplace` with `action: "sync_all"` directly (`syncAllPriceChartingOffers`), so this function is a redundant manual-trigger alias; contract-wise it inherits everything from `pricecharting-marketplace` `sync_all` (run rows will be `trigger_kind: "manual"` since the admin JWT is forwarded).

---

## 6. `marketplace-scheduler`

| | |
|---|---|
| **verify_jwt** | `true` |
| **Methods** | any (only `OPTIONS` special-cased); intended `POST` |
| **Classification** | **Internal / scheduler** — never called from the browser |

**Authentication:** the bearer token must **exactly equal** `SUPABASE_SERVICE_ROLE_KEY`; otherwise `403 { status: "error", message: "Service authorization required." }`. (With `verify_jwt = true` the gateway also requires the bearer to be a valid JWT — the service-role key satisfies that.)

**Behavior:** server-side `fetch` to `.../functions/v1/pricecharting-marketplace` with `{ action: "sync_all" }`, authenticating **as the service role** (so the sync run is recorded as `trigger_kind: "scheduled"`). Proxied response returned verbatim.

**Notes:** no cron definition exists in the repo — the schedule must be configured outside the codebase (e.g. Supabase scheduled invocation or an external cron) with the service-role key. Request body ignored. Idempotency/side effects: those of `pricecharting-marketplace` `sync_all`.

---

## 7. `market-intelligence`

| | |
|---|---|
| **verify_jwt** | **Not listed in `config.toml`** — the platform default (`true`) applies. Flagged under Ambiguities: it should arguably be pinned explicitly. |
| **Methods** | any with a JSON body (only `OPTIONS` special-cased); invoked as `POST` |
| **Classification** | Browser-callable — **any authenticated user** (customer or admin); read-only |
| **Intended V2 UI flow** | Market intelligence section on slab/card detail — `src/lib/market/client.ts` `fetchMarketIntelligence` from `src/components/market/MarketIntelligenceSection.tsx` |

**Authentication / authorization:** `getCallerUser` → `401`. Row access is delegated to **RLS**: the slab/card is read through an anon-key client that forwards the caller's `Authorization` header, so the caller only sees rows their policies allow (`404 "not found or not accessible"` otherwise). No admin check — deliberately usable by customers.

**Request body:**

```ts
{ slab_id: string } | { card_id: string }   // exactly one required
```

**Success response (200, `X-Request-Id` header):**

```ts
{
  identity_hash: string; grade_tier: string;
  verified_sales: unknown[]; active_listings: unknown[]; grade_tiers: unknown[];
  summary: { count: number; ... }; provenance: ProviderProvenance[];
  generated_at: string; ...
}
```

The assembled body is schema-validated before returning; a failed validation returns `502 { error, code: "invalid_response", request_id }` rather than malformed data. Per-provider failures are embedded as typed provenance errors (`{ source, code: "not_configured" | "rate_limited" | "provider_error" | "network_error" | "unauthorized", message, retryable }`) — the endpoint still returns 200 with degraded data.

**Errors:** `400 { error: "Invalid request body." | "A slab_id or card_id is required.", request_id }`; `404` slab/card not found/accessible; `500 { error, code: "internal_error", request_id }`. (Error bodies use `error` + `code`, not the `status`/`error_code` envelope — see Ambiguities.)

**Idempotency / retry:** pure read; per-isolate in-memory cache (10 min TTL, 250 entries) keyed on identity hash + tier + providers. Safe to retry.

**Side effects / external:** PriceCharting product API (`PRICECHARTING_API_TOKEN`), eBay Browse API via client-credentials app token (`EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET`); the `ebay_sold` (connected-seller verified sales) source is currently a stub returning `not_configured`. **No DB writes.** Structured JSON logs with request id + stage (no PII/tokens).

**Tables:** reads `slabs` or `cards` (RLS-scoped) only.

---

## 8. `ebay-oauth-start`

| | |
|---|---|
| **verify_jwt** | `true` |
| **Methods** | `POST` (JSON) via the shared `handleEbay(req, "oauth_start")` router |
| **Classification** | Browser-callable, **admin only** |
| **Intended V2 UI flow** | "Connect eBay" — `startEbayOAuth()` in `src/lib/slabs/ebay-data.ts` / `data.ts` from `EbaySellerPanel.tsx`; sends the current relative path as `redirect_after` |

**Request body:** `{ redirect_after?: string }` — a **relative** app path to return to after the OAuth hop (absolute URLs are ignored by the callback's open-redirect guard).

**Behavior:** requires `EBAY_RU_NAME` + `EBAY_REDIRECT_URI` (else `409 unavailable`). Generates a 64-hex random `state`, stores **only its SHA-256** with a 10-minute expiry and the requester id via RPC `ebay_oauth_state_create_single_flight` (atomically expires the admin's prior unconsumed states under an advisory lock — single-flight). Builds the eBay authorize URL with the canonical scope set (`api_scope`, `commerce.identity.readonly`, `sell.account`, `sell.inventory`, `sell.fulfillment`, `sell.finances`; sandbox adds `prompt=login`).

**Responses:** `200 { status: "success", authorization_url, expires_in_seconds: 600 }`; `500 { status: "error", error_code: "STATE_PERSISTENCE_FAILED", ... }` (fail loudly — never hand out a URL whose callback cannot validate); `409 unavailable` when unconfigured; `401` non-admin.

**Side effects / tables:** `private.ebay_oauth_states` via RPC. No external calls.

**Idempotency:** repeated calls supersede prior states (single-flight), so only the newest authorization URL can complete.

---

## 9. `ebay-oauth-callback`

| | |
|---|---|
| **verify_jwt** | **`false`** — eBay redirects the user's **browser** here; there is no Supabase JWT on that request |
| **Methods** | `GET` (query params `code`, `state`, `error`) |
| **Classification** | Browser redirect target (OAuth callback) — not invoked from app code |
| **Compensating verification** | (1) `state` must hash-match a **stored, unconsumed, unexpired** single-use state created by an admin via `ebay-oauth-start`; (2) the authorization `code` is exchanged server-to-server with eBay using the confidential client credentials. A replayed/stale/unknown state → redirect `?ebay=invalid_state`. |

**Response shape:** never JSON — **every** outcome is a `302` to `EBAY_APP_BASE_URL` (default `https://gradedcardvalue.com`) + path + `?ebay=<marker>`. Only a same-app relative `redirect_after` from the stored state is honored (open-redirect guard; anything else falls back to `/slabs`). Markers: `connected`, `denied` (user declined consent), `invalid_callback`, `invalid_state`, `config_error` (no `EBAY_TOKEN_ENCRYPTION_KEY`), `error` (token exchange / identity request failure), `identity_scope_missing`, `identity_unavailable`, `persist_error`, `scope_persist_failed`.

**Behavior (ordered, stage-verified — `resolveEbayCallback` in `_shared/ebay-oauth-core.ts`):**
1. Exchange `code` for tokens (`/identity/v1/oauth2/token`, Basic auth with client id/secret).
2. Fetch the seller's **opaque** user id via Commerce Identity `getUser` on the `apiz` gateway (requires `commerce.identity.readonly`; 403 → `identity_scope_missing`). No PII identity scopes are requested.
3. Upsert `ebay_accounts` (`ebay_user_id`, `connection_status: "connected"`, `connected_at`, authorization expiry). `connected_at` marks connection, **not** a completed sync.
4. Persist the refresh token **AES-GCM-encrypted** (`EBAY_TOKEN_ENCRYPTION_KEY`) via service-role RPC `ebay_oauth_credential_upsert` into the `private` schema, then persist scope provenance (`ebay_credential_scopes_set`) with a **read-after-write** check (`ebay_credential_scopes_get`).
5. Only after all of the above succeed: consume the state (`ebay_oauth_state_consume`) and **confirm** consumption.

**Idempotency / retry:** any failure before credential persistence leaves the state **unconsumed** so a genuine retry can succeed; success consumes it so the callback cannot be replayed. Failures log a safe structured diagnostic (stage + upstream HTTP status only — never tokens/code/state).

**Tables / RPCs:** `ebay_accounts`; `private.ebay_oauth_states` + `private.ebay_oauth_credentials` via `ebay_oauth_state_get/_consume`, `ebay_oauth_credential_upsert`, `ebay_credential_scopes_set/_get`. External: eBay OAuth + Identity APIs.

---

## 10. `ebay-account-sync`

| | |
|---|---|
| **verify_jwt** | `true` |
| **Methods** | `POST` (JSON) — dedicated V2 handler `_shared/ebay-account-sync-v2.ts` (not the shared `handleEbay` router) |
| **Classification** | Browser-callable, **admin only** |
| **Intended V2 UI flow** | "Sync eBay account" discovery in `EbaySellerPanel.tsx` via `ebaySellerOperation("ebay-account-sync", { account_id })` |

**Request body:** `{ account_id: string (required); marketplace_id?: string = "EBAY_US" }` → `400 MISSING_ACCOUNT` without account_id.

**Token handling:** decrypts the stored refresh token (RPC `ebay_oauth_credential_get`), refreshes the access token with the full persisted scope set (never dropped), and persists any **rotated** refresh token with optimistic concurrency (RPC `ebay_oauth_credential_rotate`, conditioned on the prior ciphertext; 0 rows = concurrent rotation won). Refresh failures are classified (`ebay-oauth-refresh-classifier`) into a typed response:

```ts
{ status, error_code, retryable: boolean, reconnect_required: boolean, correlation_id, message } // + classifier HTTP status
```

`reconnect_required: true` also sets `ebay_accounts.connection_status = "reauthorization_required"`.

**Discovery reads (read-only):** Identity `getUser` (apiz), `/sell/account/v1/privilege`, `/sell/inventory/v1/location?limit=100`, fulfillment/payment/return policies for the marketplace. Each sub-operation records its own `ebay_api_runs` row (operation, status, HTTP, latency, correlation id).

**Persistence:** replace-style RPCs run **only after complete successful fetches** — `ebay_inventory_locations_replace` (only if the locations read succeeded) and `ebay_business_policies_replace` (only if **all three** policy reads succeeded) — so last-known-good snapshots are preserved on any partial failure. `ebay_accounts` updated (`connection_status`, `privilege_status: "verified" | "unverified"`). `ebay_sync_cursors` touched with `account_discovery_attempt` always and `account_discovery_complete` **only** when identity + privileges + locations + all policies + all persistence succeeded (a partial run never looks complete).

**Responses:** `200 { status: "success" | "partial", account_id, opaque_user_id, privilege_status, retryable, reconnect_required: false, correlation_id, snapshots_preserved, resources: { identity, privileges, locations, fulfillment_policies, payment_policies, return_policies → { status, http, count, error_code } }, message }`; `500 { status: "error", error_code: <persist code>, retryable: true, ... }` on any persistence failure. Counts are **confirmed post-write counts** returned by the RPCs, never the submitted row counts. No seller PII or raw provider bodies are returned.

**Idempotency / retry:** replace-with-prune semantics; safe to retry; `partial` responses are explicitly `retryable: true`.

**Tables:** `ebay_accounts`, `ebay_inventory_locations`, `ebay_business_policies`, `ebay_sync_cursors`, `ebay_api_runs`, `private.ebay_oauth_credentials` (via RPCs). External: eBay Identity/Account/Inventory APIs.

*(Note: `_shared/ebay.ts` still contains an older `account_sync` branch in `handleEbay`, but the deployed entrypoint `ebay-account-sync/index.ts` serves the V2 handler above.)*

---

## 11. `ebay-reference-search`

| | |
|---|---|
| **verify_jwt** | `true` |
| **Methods** | `POST` (JSON) via `handleEbay(req, "reference_search")` |
| **Classification** | Browser-callable, **admin only** |
| **Intended V2 UI flow** | Reference listing images during slab intake — `ebayReferenceSearch` in `src/lib/slabs/data.ts` (used by intake/PriceCharting panels) |

**Request body:** `{ query: string (required); marketplace_id?: string = "EBAY_US"; card_name?: string; card_number?: string }` → `400 MISSING_QUERY` when empty.

**Behavior:** obtains a client-credentials **application** token (no seller account needed), calls Browse `item_summary/search` (limit 10), then filters results server-side: title must contain every token of `card_name` and match the collector number (leading zeros tolerated); returns at most 5.

**Success response:**

```ts
{ status: "success", source: "EBAY_BROWSE", active_listings_only: true,
  items: Array<{ item_id, title, image_url, additional_images: string[], item_url,
                 price, condition: { raw, label }, source_label: "Reference Listing",
                 market_label: "Active Asking Price", sold_comparable: false }> }
```

**Errors:** `401` non-admin; `409 unavailable` if eBay unconfigured. A Browse/token failure **throws** and is not caught inside `handleEbay`, so the runtime returns a generic 500 (without the structured envelope) — the frontend wrapper maps any invoke error to `{ status: "unavailable", items: [] }`.

**Idempotency / side effects:** pure read; no DB writes; safe to retry.

---

## 12. `ebay-list-item`

| | |
|---|---|
| **verify_jwt** | `true` |
| **Methods** | `POST` (JSON) via `handleEbay(req, "list_item")` |
| **Classification** | Browser-callable, **admin only**; the publish step is a gated **external mutation** |
| **Intended V2 UI flow** | Listing preparation + publish in `EbaySellerPanel.tsx` (`ebaySellerOperation("ebay-list-item", …)`) — prepare first, review, then confirm `PUBLISH` |

### Phase A — preparation (no `confirmation`, or anything ≠ `"PUBLISH"`)
Read-only, **fail-closed** probes with the seller token: privileges, locations, the three policy types, and (when `category_id` is provided) taxonomy category aspects + item-condition policies. Each probe reports its own `{ status: "success" | "error" | "not_requested", http }` — a failed provider call is never masked as an empty object.

Request: `{ account_id: string; marketplace_id?: string = "EBAY_US"; category_id?: string }`.

Response `200`:

```ts
{ status: "prepared" | "partial", confirmation_phrase: "PUBLISH",
  resources: { privileges, inventory_locations, fulfillment_policies, payment_policies,
               return_policies, category_aspects, condition_policies },
  privileges, inventory_locations, business_policies: { fulfillment, payment, return },
  category_aspects, condition_policies, message }
```

Only `"prepared"` (every required resource ok) should let the client enable Publish.

### Phase B — publish (`confirmation: "PUBLISH"`)
Routed through `routeListingWithToken` (`_shared/ebay-listing-handler.ts`). The `EBAY_LISTING_MUTATIONS_ENABLED` flag is gated **before** the seller token is loaded — a disabled publish makes zero OAuth/credential/provider calls and zero writes (`403 mutation_disabled`).

Request:

```ts
{
  account_id: string; confirmation: "PUBLISH";
  slab_id: string; sku?: string;               // sku, if sent, must equal the canonical SKU
  marketplace_id?: string = "EBAY_US"; category_id: string;
  merchant_location_key: string;
  fulfillment_policy_id: string; payment_policy_id: string; return_policy_id: string;
  price_value: number; currency: "USD";        // USD enforced
  condition: string; condition_description?: string;
  title: string;                                // 1–80 chars
  description: string;
  quantity?: number;                            // integer, 1..MAX_QUANTITY (default 1)
  aspects?: Record<string, unknown>;
}
```

Pipeline: validate (→ `400 INCOMPLETE_LISTING` / `invalid_quantity`) → load slab (`404 slab_not_found`; canonical SKU derived from `inventory_number`, mismatch → `400 canonical_sku_mismatch`; front image required → `400 front_image_required`) → verify **ownership** of the location and all three policies for this `account_id` + marketplace (`400 unknown_location` / `location_not_enabled` / `unknown_*_policy` / `policy_marketplace_mismatch`; `500 ownership_check_failed`) → sign image URLs (1 h) and SHA-256-hash the stored image bytes into a **durable image manifest** (`502 image_url_generation_failed` / `image_manifest_failed`) → build canonical intended state + fingerprint → acquire the **single-flight publish lease** (`ebay_publish_lease_acquire`, 120 s TTL; `409 publish_in_progress` if held; the lease is asserted-and-extended before every provider mutation and released on every path) → executor: PUT `inventory_item/{sku}` → POST `offer` → POST `offer/{id}/publish` → **atomic** local reconcile via transactional RPC `ebay_listing_reconcile_local` (identity + fingerprint + expected-version proven under a row lock; mapping and intent written in one transaction).

**Response statuses** (from `executePublish`, snake_case body via `execBody`): `200 { status: "success", offer_id, listing_id, listing_status: "published", … }`; `409` conflict states — `publish_in_progress`, `publish_lease_lost`, `offer_created_unpersisted` ("run reconcile"), fingerprint/intent divergence codes; `502` provider failures (`inventory_put_failed`, `offer_creation_failed`, `publish_failed`); `500` persistence failures with **honest partial-state statuses**: `published_unmapped` (listing LIVE but local write failed — run reconcile; the listing is NOT withdrawn), `published_recovery_unpersisted`, `offer_created_recovery_unpersisted`, `intent_persist_failed`, plus `diagnostic_unpersisted: true` when even the diagnostic could not be saved.

**Idempotency / retry:** publish is fenced by the lease + durable intent + fingerprint: a retry after `offer_created_unpersisted` re-adopts the existing eBay offer via reconcile instead of creating a duplicate; the intent upsert is keyed on `(ebay_account_id, sku)`.

**Tables / storage:** `ebay_listing_intents`, `ebay_listing_mappings`, `public/private ebay_publish_leases` (via RPCs), `ebay_api_runs`, `slabs` (read); storage bucket **`slab-images`** (read + signed URLs + byte hashing). External: eBay Sell Inventory/Offer + Taxonomy/Metadata APIs.

---

## 13. `ebay-revise-item`

| | |
|---|---|
| **verify_jwt** | `true` |
| **Methods** | `POST` (JSON) via `handleEbay(req, "revise_item")` |
| **Classification** | Browser-callable, **admin only** |
| **Intended V2 UI flow** | Price/quantity revision and **reconcile** recovery in `EbaySellerPanel.tsx` |

### Mode 1 — `action: "reconcile"`
Request: `{ account_id: string; action: "reconcile"; slab_id: string; sku?: string; currency?: string = "USD" }`. **Not** gated by the mutation flag (it performs no provider mutation): it re-reads provider state (paginated fail-closed `getOffers` + `getInventoryItem`), verifies it against the **durable intended-state snapshot**, and atomically repairs the local mapping/intent via `ebay_listing_reconcile_local`. Responses: `200 { status: "success", reconciled: true, offer_id, listing_id }`; `404 no_live_offer` / `no_listing_intent`; `409 reconcile_requires_intended_state` or divergence codes; `502` incomplete provider verification; `500` persistence failures (`published_unmapped` etc., same honest statuses as publish).

### Mode 2 — revise (default)
Gated by `EBAY_LISTING_MUTATIONS_ENABLED` (`403 mutation_disabled`) + phrase `confirmation: "REVISE"` (`409 confirmation_required`).

Request: `{ account_id: string; confirmation: "REVISE"; offer_id: string; price_value?: number; quantity?: number; currency?: string = "USD" }` → `400 MISSING_OFFER` without `offer_id`. PUTs the offer patch (`pricingSummary` and/or `availableQuantity`) to eBay, then updates `ebay_listing_mappings` (`asking_price_cents`, `last_synced_at`).

Responses: `200 { status: "success", offer_id, listing_status: "published" }`; `500 { status: "revise_unmapped", offer_id }` — eBay succeeded but the local mapping update failed (honest partial state). Provider errors throw → generic 500.

---

## 14. `ebay-end-item`

| | |
|---|---|
| **verify_jwt** | `true` |
| **Methods** | `POST` (JSON) via `handleEbay(req, "end_item")` |
| **Classification** | Browser-callable, **admin only**; external listing mutation |
| **Intended V2 UI flow** | "End listing" in `EbaySellerPanel.tsx` |

Gated by `EBAY_LISTING_MUTATIONS_ENABLED` + phrase `confirmation: "END"`.

**Request:** `{ account_id: string; confirmation: "END"; offer_id: string }`. Calls eBay `offer/{id}/withdraw`, then updates `ebay_listing_mappings.listing_status = "ended"`.

**Responses:** `200 { status: "success", offer_id, listing_status: "ended" }`; `500 { status: "end_unmapped", offer_id }` when the withdraw succeeded but the local update failed; `403 mutation_disabled`; `409 confirmation_required`. Note: an empty `offer_id` is not explicitly rejected before the provider call (the eBay call would fail and throw → 500).

---

## 15. `ebay-order-sync`

| | |
|---|---|
| **verify_jwt** | `true` |
| **Methods** | `POST` (JSON) via `handleEbay(req, "order_sync")` |
| **Classification** | Browser-callable, **admin only** |
| **Intended V2 UI flow** | "Sync orders" + "Apply sales" in `EbaySellerPanel.tsx` |

### Default mode — inbound sync (no confirmation)
Request: `{ account_id: string }`. Non-destructive, **complete-pagination** inbound sync through the shared watermark orchestrator (`runOrderSync`):

1. **Single-flight lease** per `(account, "orders")` via `ebay_sync_lease_acquire` (300 s TTL) → `409 { status: "sync_in_progress" }` if held.
2. Durable run identity + high-watermark load (`ebay_sync_state_load`).
3. Fail-closed paginated Fulfillment `getOrders` (filter `lastmodifieddate:[watermark-overlap..]`, limit 200/page; 90-day bounded initial window), with the lease **asserted-and-extended before every page**.
4. SKU→slab mapping lookups (`ebay_listing_mappings`) and persistence via RPC `ebay_orders_persist` in bounded, lease-fenced batches (200 SKUs / 100 orders); the RPC returns **confirmed durable totals** read back from the private tables (idempotent under retries and watermark overlap).
5. Atomic completion (`ebay_sync_complete`: watermark advance + counters, verified under the lease) or failure recording (`ebay_sync_state_fail`), plus `ebay_api_runs`.

Success `200` (`syncBody`):

```ts
{ status: "success", mode: "synced",
  pages_fetched, records_fetched, records_persisted, deduplicated,
  processed_orders, processed_lines,
  confirmed_order_total, confirmed_line_total, durable_total, durable_secondary,
  proposed_sales: unknown[], proposed_sale_count, orders_synced,
  high_watermark_at, source_label: "Seller’s Completed Sale", message,
  recovery_unpersisted?: true,    // failure/audit write could not be persisted
  release_unconfirmed?: true }    // committed but lease release unconfirmed
```

Failures: `409 sync_in_progress` / `lease_lost`; `500`/`502` with `error_code` (`sync_lease_lost`, `mapping_lookup_failed`, `orders_persist_failed`, `sync_begin_failed`, `sync_internal_error`, …). Ordinary sync **never** marks a slab sold, creates a sold comp, or mutates a listing; `proposed_sales` are derived only from successfully persisted lines.

### `APPLY_SALES` mode (`confirmation: "APPLY_SALES"`)
Gated by `EBAY_APPLY_SALES_ENABLED` (`403 mutation_disabled`, kind `apply-sales`). Request: `{ account_id, confirmation: "APPLY_SALES", sales: unknown[] }` (selected, already-persisted sale lines) → `400 no_sales_selected` when empty. Applies via RPC `ebay_sales_apply` (which validates staleness/matching in SQL). Response: `200 { status: "success", mode: "sales_applied", sales_applied, skipped_stale, skipped_unmatched }`; `500 sales_apply_failed` / `api_run_persist_failed`. This is the **only** path that touches local slab inventory / sold comps, and it operates purely over persisted lines (never re-fetches provider data).

**Tables:** `private.ebay_orders`, `private.ebay_order_line_items` (via `ebay_orders_persist`), `private.ebay_sync_leases`, `ebay_sync_state`, `ebay_listing_mappings` (read), `ebay_api_runs`; apply-sales touches `slabs` / `sold_comps` via `ebay_sales_apply`. External: eBay Sell Fulfillment API (`api.ebay.com`).

---

## 16. `ebay-fulfillment`

| | |
|---|---|
| **verify_jwt** | `true` |
| **Methods** | `POST` (JSON) via `handleEbay(req, "fulfillment")` |
| **Classification** | Browser-callable, **admin only**; external mutations (shipping / money movement) |
| **Intended V2 UI flow** | Ship / refund actions in `EbaySellerPanel.tsx` |

**Request body:**

```ts
{
  account_id: string;
  action?: "ship" (default) | "refund";
  confirmation: "SHIP" | "REFUND";          // matching the action
  order_id: string;
  // ship:
  line_items?: unknown[]; shipped_at?: string;
  shipping_carrier_code?: string; tracking_number?: string;
  // refund:
  refund?: Record<string, unknown>;          // passed through to eBay issue_refund
}
```

**Gating:** `ship` requires `EBAY_FULFILLMENT_MUTATIONS_ENABLED`; `refund` requires `EBAY_FINANCIAL_MUTATIONS_ENABLED` (money movement — `403 mutation_disabled` kind `financial`). Then the phrase check (`409 confirmation_required`).

**Behavior:** `ship` → POST `/sell/fulfillment/v1/order/{orderId}/shipping_fulfillment`; `refund` → POST `/sell/fulfillment/v1/order/{orderId}/issue_refund`.

**Responses:** `200 { status: "success", action: "ship", order_id, fulfillment_id }` or `{ status: "success", action: "refund", order_id, refund_id }`. Provider failures throw → generic 500.

**Side effects / tables:** external eBay mutation only — **no local DB writes**; local order/finance state catches up on the next `order_sync` / `finances_sync`. **Idempotency: none** (no idempotency key; a retry after an ambiguous failure could double-submit — mitigated operationally by the confirmation phrase and flags).

---

## 17. `ebay-finances-sync`

| | |
|---|---|
| **verify_jwt** | `true` |
| **Methods** | `POST` (JSON) via `handleEbay(req, "finances_sync")` |
| **Classification** | Browser-callable, **admin only**; read-only inbound sync |
| **Intended V2 UI flow** | "Sync finances" in `EbaySellerPanel.tsx` |

**Request:** `{ account_id: string }`.

**Behavior:** same watermark orchestrator as `order_sync` but for the Finances API on the **apiz** gateway (`getTransactions`, filter `transactionDate:[…]`, limit 200/page, 90-day initial window, lease resource `"finances"`, batches of 100 via RPC `ebay_finance_transactions_apply` with confirmed durable totals). It never issues a refund, creates a payout, moves money, or alters a slab/sold comp; unknown enum / `CustomCode` values are preserved as-is.

**Responses:** `200 { status: "success", pages_fetched, records_fetched, records_persisted, deduplicated, durable_total, high_watermark_at, financial_transactions_synced, financial_transactions_total, note, recovery_unpersisted?, release_unconfirmed? }`; `409 sync_in_progress`; `500`/`502` typed failures (`finances_persist_failed`, …).

**Tables:** `private.ebay_financial_transactions` (via RPC), `private.ebay_sync_leases`, `ebay_sync_state`, `ebay_api_runs`. External: eBay Finances API (`apiz.ebay.com`).

---

## 18. `ebay-notification-handler`

| | |
|---|---|
| **verify_jwt** | **`false`** — inbound webhook from eBay; no Supabase JWT exists on these requests |
| **Methods** | `GET` (endpoint-validation challenge) and `POST` (notification delivery) |
| **Classification** | **Webhook** — never called by the browser |
| **Compensating verification** | GET: eBay challenge protocol; POST: **ECDSA signature verification over the exact raw body** (fail closed) |

**GET (challenge):** query `challenge_code`; requires env `EBAY_NOTIFICATION_VERIFICATION_TOKEN` + `EBAY_NOTIFICATION_ENDPOINT` (else `503`). Returns `200 { challengeResponse: sha256(challenge_code + token + endpoint) }`.

**POST (notification):** reads the raw body, parses the base64 `x-ebay-signature` header (`{ kid, signature, alg?, digest? }`), fetches eBay's public key for the `kid` via `GET /commerce/notification/v1/public_key/{kid}` using a server-side **application token** (cached ~1 h), and verifies the DER-ECDSA signature over the raw bytes (P-256/384/521, SHA-1 default per eBay). Everything fails closed with a typed reason.

**Response contract** (`processEbayNotification`):
- Invalid/missing/tampered signature → **`412`** `{ status: "error", error_code: "SIGNATURE_NOT_VERIFIED", reason }` (eBay's documented signature-rejection code); persistence is **not** attempted.
- Verified but the inbox write fails → **`503`** `{ status: "error", error_code: "INBOX_PERSIST_FAILED", notification_id }` — deliberately **not** acknowledged so eBay resends (no event lost, dedup path not poisoned).
- Persisted (including a replayed duplicate) → **`200`** `{ status: "success", notification_id }`.

**Idempotency:** the inbox upsert on `ebay_notifications.notification_id` with `ignoreDuplicates: true` makes a replayed notification a no-op success (replay-safe). The row stores `notification_id`, `topic`, `status: "received"`, and the payload's SHA-256 — the raw body / buyer PII never appears in the response.

**Tables:** `ebay_notifications`. External: eBay Notification API (public key fetch) + OAuth (app token).

---

## Ambiguities and observations

1. **`market-intelligence` is missing from `config.toml`.** It relies on the platform default `verify_jwt = true`. Behavior is correct today, but the setting is implicit rather than pinned like the other 17 entries.
2. **`pricecharting-sync` appears to be a legacy alias.** No `src/` code calls it; the UI triggers `pricecharting-marketplace` `{ action: "sync_all" }` directly. It remains deployed and admin-gated.
3. **`marketplace-scheduler` has no schedule in the repo.** The cron/scheduler wiring (and hence whether it runs at all) lives outside the codebase. It authenticates by comparing the bearer to the raw service-role key.
4. **`pricecharting-marketplace` `sync_all` has no lease** — concurrent invocations (scheduler + admin) can run simultaneously, each creating its own `pricecharting_sync_runs` row and double-spending the 1 req/s PriceCharting budget (the durable reserver still spaces individual requests).
5. **Unhandled provider exceptions in some `handleEbay` branches** (`reference_search`, `revise_item`, `end_item`, `fulfillment` provider calls) throw out of the handler and surface as a generic runtime 500 **without** the structured envelope or CORS headers. The frontend wrappers degrade gracefully (`normalizeFunctionInvokeError` falls back to a generic message), but these paths bypass the typed error contract.
6. **`ebay-fulfillment` has no local write and no idempotency key.** A retried ship/refund after an ambiguous network failure could double-submit at eBay. Refunds are additionally protected by the `EBAY_FINANCIAL_MUTATIONS_ENABLED` kill switch (default off) and the `REFUND` phrase.
7. **`ebay-end-item` does not validate `offer_id` non-empty** before the provider call (contrast `revise_item`'s `MISSING_OFFER` check); an empty id fails at eBay and surfaces as a generic 500.
8. **`analyze-slab`'s daily quota fails open** on DB errors (explicitly documented in `_shared/quota.ts` as an operator spend-ceiling); `scan-card`'s per-user quota fails closed. This asymmetry is intentional per the code comments but worth knowing for V2 cost controls.
9. **Method enforcement is uneven.** `analyze-slab`, `scan-card`, `pricecharting-search`, and `pricecharting-marketplace` reject non-POST with 405; the `handleEbay` family, `market-intelligence`, `pricecharting-sync`, and `marketplace-scheduler` do not check the method (other than the OPTIONS preflight and the notification GET path).
10. **CORS is wildcard (`*`) everywhere**, including webhook and scheduler endpoints. Auth still gates access; this only affects browser-origin policy.
11. **`market-intelligence` uses a different error envelope** (`{ error, code?, request_id }`) from the `{ status, error_code, message }` convention used everywhere else; its client throws `Error(message)` rather than returning a structured object.
12. **Duplicate legacy code path:** `_shared/ebay.ts` still contains an in-router `account_sync` implementation, but the deployed `ebay-account-sync` entrypoint uses the V2 handler in `_shared/ebay-account-sync-v2.ts`. Only the V2 contract (correlation ids, typed refresh-failure classification, `retryable`/`reconnect_required`) is reachable.
