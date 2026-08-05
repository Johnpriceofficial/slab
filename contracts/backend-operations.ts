// contracts/backend-operations.ts
// The typed, frontend-facing operation contract for Graded Card Value V2.
//
// Merged source of truth: Supabase schema at 77 migrations
// (20260709000000..20260915000000), main commit 6d2faea09b428f36d15ef2cbd82ae1643bc27c43.
//
// RELEASED STATE: there is no pending proposed migration layer — the proposed
// facts in the version suffix equal the merged facts (`-m77-proposed-m77`).
// See contracts/proposed/PROPOSED_STATE.json for the authoritative
// merge/deploy/verification state of this revision.
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
  /**
   * Merged, deployed, and verified against a live database. Only a READY
   * operation may be called by a consumer.
   */
  | "READY"
  /**
   * The backend resource exists only on an unmerged branch and is not deployed.
   * Consumers MUST NOT call it. Promote to READY only after staging
   * verification + merge + deploy (see contracts/PROPOSED_STATE.json).
   */
  | "PROPOSED_NOT_DEPLOYED"
  /**
   * The backend resource IS merged and deployed, but the description of it in
   * this manifest (resource, request shape, limits, authorization) is a
   * correction that lives only on an unmerged branch and has not been verified
   * against the live handler. The operation is real; this contract's account of
   * it is not yet proven. Consumers MUST NOT rely on the corrected shape until
   * it is promoted to READY.
   */
  | "PROPOSED_CONTRACT_CORRECTION"
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
/**
 * Real request body accepted by `supabase/functions/analyze-slab/index.ts` at
 * Johnpriceofficial/slab@d8088f2a. The handler reads JSON with snake_case keys
 * and base64 image payloads; there is NO `slabId` field — the slab does not
 * exist yet at analysis time. Limits come from
 * `src/server/analyze-slab/validate-images.ts`.
 */
export const ANALYZE_SLAB_LIMITS = {
  /** 15 MiB per decoded image. */
  maxImageBytes: 15_728_640,
  /** 40 MiB aggregate across front + back + variants. */
  maxAggregateBytes: 41_943_040,
  maxVariants: 8,
  mimeTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const,
} as const;

export type AnalyzeSlabMime = (typeof ANALYZE_SLAB_LIMITS.mimeTypes)[number];

// ── Wire boundary (snake_case, exactly what the handler parses) ──────────────

export interface AnalyzeSlabVariant {
  label: string;
  /** Base64-encoded bytes, no data: URL prefix. */
  image_base64: string;
  mime: AnalyzeSlabMime;
}

/**
 * WIRE type. The literal JSON body of `POST edge:analyze-slab`. Never build
 * this by hand in application code: compose a `StartSlabAnalysisRequest` and
 * call `toStartSlabAnalysisWireRequest`, which is the only sanctioned place
 * where camelCase application state becomes snake_case wire state.
 */
export interface StartSlabAnalysisWireRequest {
  /** Required. Base64-encoded bytes, no data: URL prefix. */
  front_image_base64: string;
  front_mime: AnalyzeSlabMime;
  back_image_base64?: string;
  back_mime?: AnalyzeSlabMime;
  /** Optional additional captures (angles, label close-ups); max 8. */
  variants?: AnalyzeSlabVariant[];
}

// ── Application boundary (camelCase, what the frontend composes) ─────────────

/** One image the frontend holds: bytes and their MIME always travel together. */
export interface AnalyzeSlabImage {
  /** Base64-encoded bytes, no data: URL prefix. */
  base64: string;
  mime: AnalyzeSlabMime;
}

export interface AnalyzeSlabVariantInput {
  label: string;
  image: AnalyzeSlabImage;
}

/**
 * APPLICATION type for `startSlabAnalysis`.
 *
 * The back image is modelled as one optional `AnalyzeSlabImage`, not as two
 * independent optional fields, because the canonical handler forwards the back
 * image only when BOTH `back_image_base64` and `back_mime` are present
 * (`src/server/analyze-slab/validate-images.ts`): a half-populated pair is
 * silently dropped, and the analysis would then claim a front-only evaluation
 * while the UI believed a back image was analyzed. Making the pair
 * unrepresentable at the type level removes that failure mode.
 */
export interface StartSlabAnalysisRequest {
  front: AnalyzeSlabImage;
  back?: AnalyzeSlabImage;
  variants?: AnalyzeSlabVariantInput[];
}

export type AnalyzeSlabSerializationErrorCode =
  | "MISSING_FRONT_IMAGE"
  | "UNSUPPORTED_IMAGE_MIME"
  | "TOO_MANY_VARIANTS"
  | "INCOMPLETE_BACK_IMAGE"
  | "INVALID_VARIANT_LABEL";

export interface AnalyzeSlabSerializationError {
  code: AnalyzeSlabSerializationErrorCode;
  message: string;
}

const isAnalyzeSlabMime = (value: unknown): value is AnalyzeSlabMime =>
  typeof value === "string" &&
  (ANALYZE_SLAB_LIMITS.mimeTypes as readonly string[]).includes(value);

/**
 * Bytes must be a non-empty, non-whitespace base64 string. A blank or
 * whitespace-only payload is never a real image: sending it would consume
 * quota and come back as a provider error.
 */
const hasBytes = (image: AnalyzeSlabImage | undefined): boolean =>
  Boolean(image && typeof image.base64 === "string" && image.base64.trim().length > 0);

/**
 * The single sanctioned application -> wire conversion for `startSlabAnalysis`.
 *
 * Client-side validation here is a UX nicety, never a security control: the
 * server re-validates every byte, MIME and limit in
 * `validateAnalyzeImageInput`. It exists so an obviously malformed request
 * fails locally with a typed code instead of consuming quota.
 *
 * PURITY: the function never mutates `input`, its nested image objects, its
 * variant array or its variant objects. Every emitted object is freshly
 * constructed, so a frozen input is a valid input.
 */
export function toStartSlabAnalysisWireRequest(
  input: StartSlabAnalysisRequest,
):
  | { ok: true; value: StartSlabAnalysisWireRequest }
  | { ok: false; error: AnalyzeSlabSerializationError } {
  const err = (
    code: AnalyzeSlabSerializationErrorCode,
    message: string,
  ): { ok: false; error: AnalyzeSlabSerializationError } => ({ ok: false, error: { code, message } });

  if (!hasBytes(input?.front)) {
    return err("MISSING_FRONT_IMAGE", "A front image with image bytes is required to analyze a slab.");
  }
  if (!isAnalyzeSlabMime(input.front.mime)) {
    return err("UNSUPPORTED_IMAGE_MIME", `Unsupported front image type: ${String(input.front.mime)}.`);
  }
  if (input.back !== undefined) {
    if (!hasBytes(input.back)) {
      return err(
        "INCOMPLETE_BACK_IMAGE",
        "A back image was supplied without image bytes; omit it instead of sending a partial pair.",
      );
    }
    if (!isAnalyzeSlabMime(input.back.mime)) {
      return err("UNSUPPORTED_IMAGE_MIME", `Unsupported back image type: ${String(input.back.mime)}.`);
    }
  }

  const variants = input.variants ?? [];
  if (variants.length > ANALYZE_SLAB_LIMITS.maxVariants) {
    return err(
      "TOO_MANY_VARIANTS",
      `At most ${ANALYZE_SLAB_LIMITS.maxVariants} image variants are accepted per request.`,
    );
  }
  for (const variant of variants) {
    if (typeof variant?.label !== "string" || variant.label.trim().length === 0) {
      return err("INVALID_VARIANT_LABEL", "Every image variant needs a non-blank label.");
    }
    if (!hasBytes(variant?.image)) {
      return err("UNSUPPORTED_IMAGE_MIME", `Variant "${variant.label}" is missing image bytes.`);
    }
    if (!isAnalyzeSlabMime(variant.image.mime)) {
      return err("UNSUPPORTED_IMAGE_MIME", `Variant "${variant.label}" uses an unsupported image type.`);
    }
  }

  // Freshly constructed: only the exact backend wire keys, never a reference
  // to any caller-owned object.
  const value: StartSlabAnalysisWireRequest = {
    front_image_base64: input.front.base64,
    front_mime: input.front.mime,
  };
  if (input.back) {
    // Both keys or neither - never a half pair.
    value.back_image_base64 = input.back.base64;
    value.back_mime = input.back.mime;
  }
  if (variants.length > 0) {
    // An empty array is never emitted: the canonical handler treats an absent
    // `variants` key and an empty list identically, and omitting it keeps the
    // wire body minimal.
    value.variants = variants.map((variant) => ({
      label: variant.label,
      image_base64: variant.image.base64,
      mime: variant.image.mime,
    }));
  }
  return { ok: true, value };
}


/** Arguments of rpc:save_confirmed_slab_from_analysis (positional, snake_case). */
export interface SaveConfirmedSlabFromAnalysisRequest {
  p_analysis_run_id: string;
  /** Reviewed intake payload passed through verbatim to public.create_slab. */
  p: Record<string, unknown>;
  p_front_ext: string;
  p_back_ext?: string | null;
}

export type SaveConfirmedSlabResult =
  | "created"
  | "already_saved"
  | "duplicate_certification";

export interface SaveConfirmedSlabFromAnalysisResponse {
  result: SaveConfirmedSlabResult;
  created: boolean;
  analysis_run_id: string;
  analysis_run_linked: boolean;
  owner_id: string;
  slab_id: string;
  inventory_number: number;
  inventory_code: string | null;
  front_image_path: string | null;
  back_image_path: string | null;
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
/**
 * EXACTLY the columns `public.correct_slab_identification` whitelists
 * (`v_allowed` in 20260908000000_slab_permission_model.sql). Any other key is
 * refused by the RPC with `{ ok: false, error: "field_not_correctable" }`
 * before anything is written.
 */
export const CORRECT_SLAB_IDENTIFICATION_FIELDS = [
  "card_name",
  "set_name",
  "card_number",
  "year",
  "language",
  "rarity",
  "finish",
  "variation",
  "game_or_franchise",
  "grader",
  "grade",
  "grade_label",
  "certification_number",
  "label_description",
  "notes",
] as const;

export type CorrectSlabIdentificationField =
  (typeof CORRECT_SLAB_IDENTIFICATION_FIELDS)[number];

export interface CorrectAnalysisRequest {
  slabId: string;
  /**
   * Whitelisted, human-corrected identification fields. Values are btrim'd by
   * the RPC and an empty (or whitespace-only) string clears the column to
   * NULL. `year` is cast with `::integer` AFTER the trim — a non-numeric year
   * raises a raw cast error instead of a typed refusal, so clients must
   * validate year before calling.
   */
  corrections: Partial<Pick<SlabRow, CorrectSlabIdentificationField>>;
  /**
   * Optional replay key. The RPC trims it, treats blank as absent, and
   * serializes per (owner, key) via a transaction-scoped advisory lock. A
   * replay with the SAME key and slab returns `{ ok: true, replayed: true }`
   * with the originally applied changes; the same key against a DIFFERENT
   * slab is refused with `{ ok: false, error: "idempotency_conflict" }`.
   */
  idempotencyKey?: string;
}

/** Arguments of rpc:correct_slab_identification (positional, snake_case). */
export interface CorrectSlabIdentificationWireRequest {
  p_slab_id: string;
  p_corrections: Partial<Pick<SlabRow, CorrectSlabIdentificationField>>;
  p_idempotency_key?: string | null;
}

/**
 * Soft-error codes of rpc:correct_slab_identification. The RPC returns these
 * in a `{ ok: false, error }` jsonb body with HTTP/PostgREST status 200 — it
 * does NOT raise for its typed refusals. `account_<status>` covers every
 * non-active customer_profiles.account_status (e.g. `account_suspended`,
 * `account_closed`). The only raw (raised) failures left are the `year`
 * integer cast and infrastructure errors.
 */
export type CorrectSlabIdentificationError =
  | "unauthenticated"
  | "profile_missing"
  | `account_${string}`
  | "slab_required"
  | "corrections_object_required"
  | "idempotency_conflict"
  | "not_found"
  | "field_not_correctable"
  | "no_corrections";

export type CorrectSlabIdentificationResponse =
  | {
      ok: true;
      replayed: boolean;
      slab_id: string;
      /** The whitelisted patch that was (or, on replay, had been) applied. */
      changes: Partial<Pick<SlabRow, CorrectSlabIdentificationField>>;
    }
  | {
      ok: false;
      error: CorrectSlabIdentificationError;
      /** Present only for field_not_correctable: the offending key. */
      field?: string;
    };

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

/**
 * Version string carries BOTH states explicitly, because a single
 * `<semver>-<commit>-m<count>` form made migration 68 look like part of the
 * merged commit. Shape: `<semver>-merged-<short merged commit>-m<merged
 * migration count>-proposed-m<proposed migration count>`.
 * scripts/build-contract-snapshot.mjs derives and enforces every component.
 */
export const CONTRACT_VERSION = "1.4.0-merged-6d2faea0-m77-proposed-m77" as const;


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
    backendResource: ["edge:analyze-slab"],
    reads: false,
    writes: true,
    authorization:
      "JWT; admin, or customer with ANALYZE_SLAB_CUSTOMER_ENABLED=true + confirmed email + active customer_profiles row; per-user daily quota fails closed",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: false,
    retriable: false,
    sideEffects: "AI provider call; ai_analysis_runs/ai_field_evidence rows; quota consumption",
    notes:
      "The handler edge:analyze-slab IS merged and deployed. What is PROPOSED here is this manifest's CORRECTED account of it (branch fix/atomic-confirmed-slab-save): the previous entry named edge:scan-card and an invented { slabId } body. Corrected shape, read at supabase/functions/analyze-slab/index.ts and src/server/analyze-slab/validate-images.ts: JSON with snake_case keys, front_image_base64 + front_mime required, back_image_base64/back_mime optional AND ONLY FORWARDED WHEN BOTH ARE PRESENT, variants[] (label/image_base64/mime) max 8; 15 MiB per image, 40 MiB aggregate, MIME in jpeg/png/webp/heic/heif with magic-byte match. There is NO slabId argument — the slab does not exist yet. Returns a run in 'succeeded' or 'needs_review'. edge:scan-card is the separate multipart V1 intake path and is NOT this operation. Compose StartSlabAnalysisRequest and serialize with toStartSlabAnalysisWireRequest; do not hand-build the wire body. READY: the corrected handler is merged (72e6e58) and deployed to production as analyze-slab v87 (verify_jwt=true), and its request/authorization contract was exercised live — unauthenticated/invalid JWT → 401, active confirmed customer accepted then MISSING_IMAGE on an empty body, suspended → ACCOUNT_NOT_ACTIVE, customer flag fail-closed.",
  },
  {
    name: "saveConfirmedSlabFromAnalysis",
    domain: "analysis",
    role: "customer",
    backendResource: ["rpc:save_confirmed_slab_from_analysis"],
    reads: false,
    writes: true,
    authorization:
      "auth.uid() only, fail closed and self-owned only: EVERY caller — administrators included — must own the analysis run (owner_id = auth.uid()) and the run must be in status 'succeeded' or 'needs_review'; there is no administrator override for either rule and no owner is ever read from the payload. Non-admins additionally need an active customer_profiles row. An administrator saving another account's run is refused with 42501 and creates nothing. EXECUTE revoked from public/anon, granted to authenticated.",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: true,
    retriable: true,
    sideEffects: "slabs row + ai_analysis_runs.slab_id link + audit row, in ONE transaction",
    notes:
      "READY: merged into main (72e6e58) and live in production — SECURITY DEFINER with search_path pinned, auth.uid()-only self-owned ownership (references owner_id), EXECUTE granted to authenticated and revoked from anon/public (verified live). Atomic replacement for create_slab-then-link_ai_analysis_run. Locks the run FOR UPDATE, so a replay returns result='already_saved' with the existing slab instead of creating a second one. Takes pg_advisory_xact_lock(918273645) — the same lock create_slab uses — before the certification probe, so a concurrent intake cannot slip a duplicate in between probe and insert. An existing certification returns result='duplicate_certification' (never overwritten) and leaves the run unlinked. Asserts field-evidence ownership for every caller (canonical link_ai_analysis_run skips that check for admins). A failed link rolls the created slab back.",
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
    backendResource: ["rpc:correct_slab_identification"],
    reads: false,
    writes: true,
    authorization:
      "auth.uid() only, self-owned only: the slab row is selected with owner_id = auth.uid() FOR UPDATE for EVERY caller — administrators included — so a cross-owner correction returns { ok: false, error: 'not_found' } and writes nothing; no owner is ever read from the payload. Non-admins additionally need an active customer_profiles row (profile_missing / account_<status> refusals). EXECUTE revoked from public/anon, granted to authenticated + service_role.",
    classification: "BROWSER_CUSTOMER_SAFE",
    status: "READY",
    idempotent: true,
    retriable: false,
    sideEffects:
      "whitelisted slabs column updates (btrim'd; empty string clears to NULL) + slab_correction_events append + audit_log append ('slab.identification_corrected'), in ONE transaction",
    notes:
      "READY: closes gap G1 (V1 patched public.slabs with an unwhitelisted Partial<Slab>; the permission model revokes that path). The RPC is SECURITY DEFINER with search_path pinned, merged into main in 20260908000000_slab_permission_model (72e6e58) and deployed to production, where its live definition was re-verified read-only on 2026-08-04: signature (p_slab_id uuid, p_corrections jsonb, p_idempotency_key text default null), the exact 15-column v_allowed whitelist in CORRECT_SLAB_IDENTIFICATION_FIELDS, pinned search_path, EXECUTE authenticated-only, and the owner-scoped append-only slab_correction_events table (RLS on, owner SELECT policy, (owner_id, idempotency_key) partial unique index). CONTRACT SHAPE: typed refusals are SOFT — jsonb { ok: false, error } (see CorrectSlabIdentificationError), not raised exceptions; success is { ok: true, replayed, slab_id, changes } and does NOT return the updated row, so callers must refetch the slab. Replay-safe ONLY when the caller supplies p_idempotency_key (trimmed; blank = absent; same key + different slab -> idempotency_conflict): idempotent assumes a keyed call, and retriable stays false because the key is optional at the SQL level and year casts ::integer (a non-numeric year raises). Behavioral coverage runs in CI's disposable-stack integration suite (atomic-confirmed-save.integration.test.ts and atomic-confirmed-save-boundaries.integration.test.ts): owner applies + audits, cross-owner and admin-cross-owner not_found, field_not_correctable, no_corrections, idempotency conflict/trim/replay, suspended/closed refusals, anon denied, correction-event read scoping.",
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
