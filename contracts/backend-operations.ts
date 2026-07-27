// contracts/backend-operations.ts
// The typed, frontend-facing operation contract for Graded Card Value V2.
//
// Source of truth: production Supabase schema at 65 migrations
// (20260709000000..20260904000000), repo commit ba3953fdb68c31435c7dac732f67d8d53aa2adcb.
// The Lovable V2 frontend must consume ONLY this surface via its BackendProvider —
// never raw tables, arbitrary RPCs, service-role behavior, cleanup queues, storage
// deletion, credential retrieval, or unrestricted admin mutation.
//
// `backend-capabilities.json` is GENERATED from the OPERATIONS manifest below by
// scripts/build-contract-snapshot.mjs — edit here, never the JSON.

import type { Database } from "./database.types";
import type { BackendError } from "./error-codes";

// ── Convenience row aliases (browser-visible resources only) ─────────────────
type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];

export type SlabRow = Row<"slabs">;
export type CardRow = Row<"cards">;
export type CustomerProfileRow = Row<"customer_profiles">;
export type AnalysisRunRow = Row<"ai_analysis_runs">;
export type FieldEvidenceRow = Row<"ai_field_evidence">;
export type ValuationSnapshotRow = Row<"valuation_snapshots">;
export type SoldCompRow = Row<"sold_comps">;
export type SlabCompRow = Row<"slab_comps">;
export type AuditLogRow = Row<"audit_log">;
export type CardScanReviewRow = Row<"card_scan_reviews">;
export type EbayListingIntentRow = Row<"ebay_listing_intents">;
export type PricechartingOfferRow = Row<"pricecharting_offers">;
export type BuilderRunRow = Row<"builder_runs">;

// ── Roles and classifications ────────────────────────────────────────────────
export type Role = "anon" | "customer" | "admin";

export type SecurityClassification =
  | "BROWSER_CUSTOMER_SAFE"
  | "BROWSER_ADMIN_GATED"
  | "EDGE_FUNCTION_ONLY"
  | "SERVICE_ROLE_ONLY"
  | "DESTRUCTIVE_ADMIN_ONLY"
  | "INTERNAL_ONLY"
  | "SECURITY_REVIEW_REQUIRED";

export type IntegrationStatus =
  | "READY"
  | "ADAPTER_REQUIRED"
  | "BACKEND_CONTRACT_REQUIRED"
  | "SECURITY_REVIEW_REQUIRED"
  | "DEFERRED";

export type OperationDomain =
  | "auth"
  | "profile"
  | "dashboard"
  | "inventory"
  | "intake"
  | "analysis"
  | "pricing"
  | "population"
  | "activity"
  | "admin"
  | "marketplace"
  | "ebay"
  | "builder";

// ── Session / auth ───────────────────────────────────────────────────────────
export interface SessionInfo {
  userId: string;
  email: string;
  role: Exclude<Role, "anon">;
  emailVerified: boolean;
}
export interface SignInRequest {
  email: string;
  password: string;
  /** hCaptcha token — required whenever the deployment has captcha enabled. */
  captchaToken?: string;
}

// ── Inventory ────────────────────────────────────────────────────────────────
export interface ListSlabsRequest {
  includeArchived?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}
export interface CreateSlabIntakeRequest {
  /** Payload for the create_slab RPC's `p` argument (whitelisted fields only). */
  cardName: string;
  grader: string;
  grade: string;
  gradeLabel?: string;
  certificationNumber: string;
  setName?: string;
  cardNumber?: string;
  year?: number;
  language?: string;
  rarity?: string;
  variation?: string;
  labelDescription?: string;
  frontImageExt: string;
  backImageExt?: string | null;
}
export interface UploadSlabImageRequest {
  slabId: string;
  side: "front" | "back";
  kind: "original" | "display";
  file: Blob;
  contentType: string; // bucket enforces jpeg/png/webp/heic/heif, ≤15MB
}

// ── Analysis ─────────────────────────────────────────────────────────────────
export interface StartSlabAnalysisRequest {
  slabId: string;
}
export interface AnalysisResult {
  run: AnalysisRunRow;
  evidence: FieldEvidenceRow[];
}
export interface ConfirmAnalysisRequest {
  slabId: string;
  /** Confirmation patch + event for record_pricecharting_confirmation. */
  patch: Record<string, unknown>;
  event: Record<string, unknown>;
}
export interface CorrectAnalysisRequest {
  slabId: string;
  /** Whitelisted, human-corrected identity/valuation fields. */
  corrections: Partial<
    Pick<
      SlabRow,
      | "card_name"
      | "set_name"
      | "card_number"
      | "year"
      | "language"
      | "rarity"
      | "variation"
      | "grade"
      | "grade_label"
      | "finish"
      | "game_or_franchise"
    >
  >;
}

// ── Pricing ──────────────────────────────────────────────────────────────────
export interface PricingEvidence {
  snapshots: ValuationSnapshotRow[];
  productLinks: Row<"slab_product_links">[];
  candidates: Row<"slab_product_candidates">[];
  events: Row<"slab_pricecharting_events">[];
}

// ── Marketplace / eBay (admin) ───────────────────────────────────────────────
export interface MarketplaceState {
  settings: Row<"pricecharting_marketplace_settings"> | null;
  offers: PricechartingOfferRow[];
  lastSyncRuns: Row<"pricecharting_sync_runs">[];
}

// ── Operation manifest ───────────────────────────────────────────────────────
export interface OperationSpec {
  name: string;
  domain: OperationDomain;
  role: Role;
  /** Primary backend resource(s): table, rpc:<name>, edge:<name>, storage:<bucket>, auth:gotrue */
  backendResource: string[];
  reads: boolean;
  writes: boolean;
  /** Authorization mechanism actually enforcing the call. */
  authorization: string;
  classification: SecurityClassification;
  status: IntegrationStatus;
  idempotent: boolean;
  /** True when automatic retry is safe. */
  retriable: boolean;
  sideEffects: string;
  notes?: string;
}

export const CONTRACT_VERSION = "1.1.0-ba3953fd-m65" as const;

export const OPERATIONS: readonly OperationSpec[] = [
  // auth
  {
    name: "getSession",
    domain: "auth",
    role: "anon",
    backendResource: ["auth:gotrue"],
    reads: true,
    writes: false,
    authorization: "session JWT",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
  },
  {
    name: "signIn",
    domain: "auth",
    role: "anon",
    backendResource: ["auth:gotrue"],
    reads: false,
    writes: true,
    authorization: "password + hCaptcha",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: false,
    retriable: false,
    sideEffects: "creates session",
  },
  {
    name: "signUp",
    domain: "auth",
    role: "anon",
    backendResource: ["auth:gotrue"],
    reads: false,
    writes: true,
    authorization:
      "email verification required + hCaptcha; customer_profiles row created by signup trigger",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: false,
    retriable: false,
    sideEffects: "auth user + customer_profiles row (trigger); verification email",
  },
  {
    name: "requestPasswordReset",
    domain: "auth",
    role: "anon",
    backendResource: ["auth:gotrue"],
    reads: false,
    writes: true,
    authorization: "email ownership via recovery link + hCaptcha",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: true,
    retriable: true,
    sideEffects: "recovery email",
  },
  {
    name: "updatePassword",
    domain: "auth",
    role: "customer",
    backendResource: ["auth:gotrue"],
    reads: false,
    writes: true,
    authorization: "active session (or recovery session) JWT",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: true,
    retriable: false,
    sideEffects: "credential update; other sessions may be revoked",
  },
  {
    name: "signOut",
    domain: "auth",
    role: "customer",
    backendResource: ["auth:gotrue"],
    reads: false,
    writes: true,
    authorization: "session JWT",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: true,
    retriable: true,
    sideEffects: "revokes session",
  },
  // profile
  {
    name: "getCurrentProfile",
    domain: "profile",
    role: "customer",
    backendResource: ["table:customer_profiles"],
    reads: true,
    writes: false,
    authorization: "RLS owner (user_id = auth.uid())",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
  },
  // dashboard
  {
    name: "getDashboardSummary",
    domain: "dashboard",
    role: "customer",
    backendResource: ["table:slabs", "table:cards", "table:valuation_snapshots"],
    reads: true,
    writes: false,
    authorization: "RLS owner",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "ADAPTER_REQUIRED",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
    notes: "Client-side aggregation today; a summary RPC is a future optimization, not a blocker.",
  },
  // inventory
  {
    name: "listSlabs",
    domain: "inventory",
    role: "customer",
    backendResource: ["table:slabs"],
    reads: true,
    writes: false,
    authorization: "RLS owner-or-admin",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
  },
  {
    name: "getSlab",
    domain: "inventory",
    role: "customer",
    backendResource: ["table:slabs", "table:slab_images", "storage:slab-images"],
    reads: true,
    writes: false,
    authorization: "RLS owner-or-admin; signed URLs (3600s)",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
  },
  {
    name: "listRawCards",
    domain: "inventory",
    role: "customer",
    backendResource: ["table:cards"],
    reads: true,
    writes: false,
    authorization: "RLS owner-or-admin",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
  },
  {
    name: "getRawCard",
    domain: "inventory",
    role: "customer",
    backendResource: ["table:cards", "table:card_scans", "storage:card-scans"],
    reads: true,
    writes: false,
    authorization: "RLS owner-or-admin; signed URLs",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
  },
  {
    name: "archiveSlab",
    domain: "inventory",
    role: "customer",
    backendResource: ["rpc:archive_slab"],
    reads: false,
    writes: true,
    authorization: "in-body owner-or-admin (auth.uid())",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: true,
    retriable: true,
    sideEffects: "slabs.archived_at set; audit row",
  },
  {
    name: "unarchiveSlab",
    domain: "inventory",
    role: "customer",
    backendResource: ["rpc:unarchive_slab"],
    reads: false,
    writes: true,
    authorization: "in-body owner-or-admin",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: true,
    retriable: true,
    sideEffects: "slabs.archived_at cleared; audit row",
  },
  // intake
  {
    name: "createSlabIntake",
    domain: "intake",
    role: "customer",
    backendResource: ["rpc:create_slab"],
    reads: false,
    writes: true,
    authorization: "in-body: authenticated, not suspended; owner stamped",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: false,
    retriable: false,
    sideEffects: "slabs row + inventory id + identity derivation triggers; audit",
    notes: "Duplicate certification → DUPLICATE_CERTIFICATION.",
  },
  {
    name: "createRawCardIntake",
    domain: "intake",
    role: "customer",
    backendResource: ["rpc:stage_raw_card"],
    reads: false,
    writes: true,
    authorization: "in-body: authenticated, not suspended",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: false,
    retriable: false,
    sideEffects: "cards row + R-code assignment",
  },
  {
    name: "uploadSlabImage",
    domain: "intake",
    role: "customer",
    backendResource: ["storage:slab-images", "table:slab_images"],
    reads: false,
    writes: true,
    authorization: "storage policy owner-or-admin via slab_object_owner(); bucket MIME/size limits",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "ADAPTER_REQUIRED",
    idempotent: true,
    retriable: true,
    sideEffects: "storage object + slab_images row (+ acquired_at backfill trigger)",
    notes:
      "V1 does a direct slab_images insert after upload; V2 adapter must wrap upload+register as one operation (incl. HEIC normalization).",
  },
  // analysis
  {
    name: "startSlabAnalysis",
    domain: "analysis",
    role: "customer",
    backendResource: ["edge:scan-card"],
    reads: false,
    writes: true,
    authorization: "JWT; per-user daily quota (fails closed)",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: false,
    retriable: false,
    sideEffects: "AI provider call; card_scans/ai_analysis_runs/evidence rows; quota consumption",
    notes: "Admin bulk analysis uses edge:analyze-slab (admin quota fails open).",
  },
  {
    name: "getAnalysis",
    domain: "analysis",
    role: "customer",
    backendResource: ["table:ai_analysis_runs", "table:ai_field_evidence"],
    reads: true,
    writes: false,
    authorization: "RLS owner-or-admin",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
  },
  {
    name: "confirmAnalysis",
    domain: "analysis",
    role: "customer",
    backendResource: ["rpc:record_pricecharting_confirmation"],
    reads: false,
    writes: true,
    authorization: "in-body owner-or-admin; append-only event + CHECK constraints",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: false,
    retriable: false,
    sideEffects: "slab state patch + slab_pricecharting_events append + audit",
  },
  {
    name: "correctAnalysis",
    domain: "analysis",
    role: "customer",
    backendResource: ["table:slabs"],
    reads: false,
    writes: true,
    authorization: "RLS owner-or-admin UPDATE policy",
    classification: "SECURITY_REVIEW_REQUIRED",
    status: "BACKEND_CONTRACT_REQUIRED",
    idempotent: true,
    retriable: false,
    sideEffects: "slabs field updates; identity re-derivation triggers",
    notes:
      "V1 patches slabs with an unwhitelisted Partial<Slab>. V2 needs a whitelisted correction RPC (see V2_INTEGRATION_GAPS).",
  },
  // pricing
  {
    name: "getPricingEvidence",
    domain: "pricing",
    role: "customer",
    backendResource: [
      "table:valuation_snapshots",
      "table:slab_product_links",
      "table:slab_product_candidates",
      "table:slab_pricecharting_events",
    ],
    reads: true,
    writes: false,
    authorization: "RLS owner-or-admin",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "ADAPTER_REQUIRED",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
    notes: "Multi-table aggregation into one evidence view happens in the adapter.",
  },
  {
    name: "refreshPricing",
    domain: "pricing",
    role: "admin",
    backendResource: ["edge:pricecharting-search", "rpc:apply_slab_pricing"],
    reads: true,
    writes: true,
    authorization: "JWT admin; durable 1req/s provider pacing; stale-write guard",
    classification: "BROWSER_ADMIN_GATED",
    status: "ADAPTER_REQUIRED",
    idempotent: false,
    retriable: false,
    sideEffects: "provider lookup; valuation snapshot + tier updates; audit",
    notes: "Rate-limit → RATE_LIMITED; stale guard → STALE_WRITE.",
  },
  {
    name: "listSoldComparables",
    domain: "pricing",
    role: "customer",
    backendResource: ["table:sold_comps", "table:slab_comps"],
    reads: true,
    writes: false,
    authorization: "RLS owner-or-admin",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
  },
  // population
  {
    name: "getCgcPopulation",
    domain: "population",
    role: "customer",
    backendResource: ["table:cgc_population_cards", "table:cgc_population_sets"],
    reads: true,
    writes: false,
    authorization:
      "NONE USABLE — admin-read policies exist but client grants are absent (surface is postgres-internal today)",
    classification: "SECURITY_REVIEW_REQUIRED",
    status: "BACKEND_CONTRACT_REQUIRED",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
    notes: "Needs a read view/RPC + grant decision before any V2 exposure.",
  },
  // activity
  {
    name: "listActivity",
    domain: "activity",
    role: "customer",
    backendResource: ["table:audit_log"],
    reads: true,
    writes: false,
    authorization: "RLS owner-read (audit_log_owner_read); admin sees all",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
  },
  // admin
  {
    name: "getAdminReviewQueue",
    domain: "admin",
    role: "admin",
    backendResource: ["table:card_scan_reviews", "table:card_scans"],
    reads: true,
    writes: false,
    authorization: "RLS admin policies (is_admin)",
    classification: "BROWSER_ADMIN_GATED",
    status: "READY",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
  },
  {
    name: "resolveAdminReview",
    domain: "admin",
    role: "admin",
    backendResource: ["table:card_scan_reviews"],
    reads: false,
    writes: true,
    authorization: "RLS admin UPDATE policy",
    classification: "BROWSER_ADMIN_GATED",
    status: "ADAPTER_REQUIRED",
    idempotent: true,
    retriable: false,
    sideEffects: "review resolution fields",
    notes: "Direct table write today; acceptable under admin RLS, wrapped by the adapter.",
  },
  // marketplace / eBay
  {
    name: "getMarketplaceState",
    domain: "marketplace",
    role: "admin",
    backendResource: [
      "table:pricecharting_marketplace_settings",
      "table:pricecharting_offers",
      "table:pricecharting_sync_runs",
    ],
    reads: true,
    writes: false,
    authorization: "RLS admin policies",
    classification: "BROWSER_ADMIN_GATED",
    status: "READY",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
  },
  {
    name: "connectEbayAccount",
    domain: "ebay",
    role: "admin",
    backendResource: ["edge:ebay-oauth-start", "edge:ebay-oauth-callback"],
    reads: false,
    writes: true,
    authorization: "JWT admin; single-flight hashed OAuth state; callback verifies state+code",
    classification: "BROWSER_ADMIN_GATED",
    status: "READY",
    idempotent: false,
    retriable: false,
    sideEffects: "ebay_accounts row; encrypted credential storage via service RPCs",
    notes: "Browser never sees tokens; reconnect flow surfaces EBAY_RECONNECT_REQUIRED.",
  },
  {
    name: "listEbayListings",
    domain: "ebay",
    role: "admin",
    backendResource: ["table:ebay_listing_intents", "table:ebay_listing_mappings"],
    reads: true,
    writes: false,
    authorization: "RLS admin policies",
    classification: "BROWSER_ADMIN_GATED",
    status: "READY",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
  },
  {
    name: "listEbayOrders",
    domain: "ebay",
    role: "admin",
    backendResource: ["private:ebay_orders", "private:ebay_order_line_items"],
    reads: true,
    writes: false,
    authorization:
      "NONE — orders live in the private schema with deny-all RLS; no admin reader RPC exists",
    classification: "SECURITY_REVIEW_REQUIRED",
    status: "BACKEND_CONTRACT_REQUIRED",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
    notes: "Needs an is_admin-gated SECURITY DEFINER reader RPC (see V2_INTEGRATION_GAPS).",
  },
  // builder
  {
    name: "getBuilderRuns",
    domain: "builder",
    role: "admin",
    backendResource: [
      "table:builder_runs",
      "table:builder_steps",
      "table:builder_approvals",
      "table:builder_tool_calls",
      "table:builder_audit_events",
    ],
    reads: true,
    writes: false,
    authorization: "authenticated SELECT (20260903) + admin-read RLS (initplan)",
    classification: "BROWSER_ADMIN_GATED",
    status: "READY",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
    notes:
      "Read-only spine; run creation/approval is DEFERRED until the builder write plane ships.",
  },
  // admin user management
  {
    name: "getAdminUsers",
    domain: "admin",
    role: "admin",
    backendResource: ["table:customer_profiles"],
    reads: true,
    writes: false,
    authorization:
      "NONE USABLE — customer_profiles RLS is self-read-only with no admin policy and no admin user-list RPC exists",
    classification: "SECURITY_REVIEW_REQUIRED",
    status: "BACKEND_CONTRACT_REQUIRED",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
    notes:
      "/admin/users needs an is_admin-gated reader (RPC or admin RLS policy) — see V2_INTEGRATION_GAPS G4.",
  },
  // subscription (no backend exists)
  {
    name: "getSubscriptionState",
    domain: "profile",
    role: "customer",
    backendResource: [],
    reads: true,
    writes: false,
    authorization: "n/a",
    classification: "SECURITY_REVIEW_REQUIRED",
    status: "DEFERRED",
    idempotent: true,
    retriable: true,
    sideEffects: "none",
    notes:
      "No billing/subscription backend exists; /account/subscription ships as static placeholder.",
  },
] as const;

/** Everything a BackendProvider method returns. */
export type BackendResult<T> = { ok: true; data: T } | { ok: false; error: BackendError };
