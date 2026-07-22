// Pre-read evaluation of the DURABLE local listing intent, using only durable
// local fields (status, fingerprint + version, recorded offer/listing ids). It
// runs AFTER the executor has cryptographically VERIFIED the stored snapshot
// (verifyDurableIntendedSnapshot) and BEFORE any provider read or `preparing`
// write, so a prior published/in-flight intent is never silently overwritten and
// an identical-input retry is idempotent. Provider-identity conflicts are decided
// later by the state engine (which needs the provider ids).
//
// Pure + cross-runtime → unit-tested from src/test/ebay.

export interface LocalIntentRecord {
  status: string;
  fingerprint: string | null;
  fingerprintVersion: number | null;
  offerId: string | null;
  listingId: string | null;
}

export type LocalIntentCode =
  | "no_existing_intent"
  | "resume_local_exact"
  | "prior_offer_created"
  | "prior_published"
  | "local_intent_inputs_changed"
  | "prior_publish_in_progress";

export interface LocalIntentGate {
  code: LocalIntentCode;
  proceed: boolean;
  writePreparing: boolean;
  offerId: string | null;
  listingId: string | null;
}

const gate = (code: LocalIntentCode, proceed: boolean, writePreparing: boolean, offerId: string | null = null, listingId: string | null = null): LocalIntentGate =>
  ({ code, proceed, writePreparing, offerId, listingId });

/**
 * Decide how a publish attempt should treat the existing (already snapshot-VERIFIED)
 * durable intent. Returns a gate the executor honors before writing `preparing` or
 * reading the provider.
 */
export function evaluateLocalIntent(existing: LocalIntentRecord | null, current: { fingerprint: string; fingerprintVersion: number }): LocalIntentGate {
  if (!existing) return gate("no_existing_intent", true, true);

  // An offer whose id was never persisted must be reconciled before any new publish.
  if (existing.status === "offer_created_unpersisted") return gate("prior_publish_in_progress", false, false);

  const sameFp = existing.fingerprint !== null && existing.fingerprint === current.fingerprint
    && existing.fingerprintVersion === current.fingerprintVersion;
  const hasOffer = !!existing.offerId;
  const hasListing = !!existing.listingId;

  if (existing.status === "published" || hasListing) {
    return sameFp ? gate("prior_published", true, false, existing.offerId, existing.listingId) : gate("local_intent_inputs_changed", false, false, existing.offerId, existing.listingId);
  }
  if (hasOffer) {
    return sameFp ? gate("prior_offer_created", true, false, existing.offerId, null) : gate("local_intent_inputs_changed", false, false, existing.offerId, null);
  }
  return sameFp ? gate("resume_local_exact", true, true) : gate("no_existing_intent", true, true);
}
