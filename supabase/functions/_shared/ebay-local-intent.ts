// Pre-read evaluation of the DURABLE local listing intent. This runs BEFORE any
// provider read and BEFORE `preparing` is written, so a prior published/in-flight
// intent is never silently overwritten and a retry with the exact same inputs is
// idempotent. Provider-identity conflicts are decided later by the state engine
// (which needs the provider IDs); this gate uses only durable local fields.
//
// Pure + cross-runtime → unit-tested from src/test/ebay.

import { parseImageManifest, parseIntendedState } from "./ebay-intended-state.ts";

export interface LocalIntentRecord {
  status: string;
  fingerprint: string | null;
  fingerprintVersion: number | null;
  offerId: string | null;
  listingId: string | null;
  intendedState: unknown;   // raw stored jsonb (or null)
  imageManifest: unknown;   // raw stored jsonb (or null)
}

export type LocalIntentCode =
  | "no_existing_intent"          // proceed: no prior row → fresh preparation
  | "resume_local_exact"          // proceed: prior attempt, no live artifact, identical inputs
  | "prior_offer_created"         // proceed(no-preparing): an offer exists locally → engine resumes/adopts
  | "prior_published"             // proceed(no-preparing): a listing exists locally → engine reconciles
  | "local_intent_inputs_changed" // BLOCK: a live/in-flight listing but inputs changed
  | "prior_publish_in_progress"   // BLOCK: an offer was created but never persisted → reconcile first
  | "invalid_intended_state";     // BLOCK: a stored snapshot is corrupt/unparseable

export interface LocalIntentGate {
  code: LocalIntentCode;
  proceed: boolean;           // may the executor continue to provider reads?
  writePreparing: boolean;    // may `preparing` be written (safe only with no live artifact)?
  offerId: string | null;
  listingId: string | null;
}

const gate = (code: LocalIntentCode, proceed: boolean, writePreparing: boolean, offerId: string | null = null, listingId: string | null = null): LocalIntentGate =>
  ({ code, proceed, writePreparing, offerId, listingId });

/**
 * Decide how a publish attempt should treat the existing durable intent, using
 * only local state (status, fingerprint + version, recorded offer/listing ids,
 * stored snapshot validity). Returns a gate the executor honors before writing
 * `preparing` or reading the provider.
 */
export function evaluateLocalIntent(existing: LocalIntentRecord | null, current: { fingerprint: string; fingerprintVersion: number }): LocalIntentGate {
  if (!existing) return gate("no_existing_intent", true, true);

  // A present snapshot MUST be valid; a corrupt snapshot fails closed and never
  // silently coerces. (Absent snapshot on a legacy/partial row is not "invalid".)
  const snapshotPresent = existing.intendedState != null || existing.imageManifest != null;
  if (snapshotPresent && (parseIntendedState(existing.intendedState) === null || parseImageManifest(existing.imageManifest) === null)) {
    return gate("invalid_intended_state", false, false);
  }

  // An offer whose id was never persisted must be reconciled before any new publish.
  if (existing.status === "offer_created_unpersisted") return gate("prior_publish_in_progress", false, false);

  const sameFp = existing.fingerprint !== null && existing.fingerprint === current.fingerprint
    && existing.fingerprintVersion === current.fingerprintVersion;
  const hasOffer = !!existing.offerId;
  const hasListing = !!existing.listingId;

  // A live listing exists locally: never re-prepare it. Same inputs → engine
  // reconciles; changed inputs → block.
  if (existing.status === "published" || hasListing) {
    return sameFp ? gate("prior_published", true, false, existing.offerId, existing.listingId) : gate("local_intent_inputs_changed", false, false, existing.offerId, existing.listingId);
  }
  // An in-flight (unpublished) offer exists locally: never discard it. Same inputs
  // → engine resumes/adopts; changed inputs → block.
  if (hasOffer) {
    return sameFp ? gate("prior_offer_created", true, false, existing.offerId, null) : gate("local_intent_inputs_changed", false, false, existing.offerId, null);
  }
  // No live artifact recorded (preparing/blocked/failed/…): safe to (re)prepare.
  // Identical inputs → idempotent resume; changed inputs → treat as a fresh prep.
  return sameFp ? gate("resume_local_exact", true, true) : gate("no_existing_intent", true, true);
}
