import { describe, it, expect } from "vitest";
import { evaluateLocalIntent, type LocalIntentRecord } from "../../../supabase/functions/_shared/ebay-local-intent";

const CUR = { fingerprint: "FP", fingerprintVersion: 3 };
const rec = (over: Partial<LocalIntentRecord> = {}): LocalIntentRecord => ({
  status: "preparing", fingerprint: "FP", fingerprintVersion: 3, offerId: null, listingId: null, intendedState: null, imageManifest: null, ...over,
});

describe("evaluateLocalIntent — pre-read gate", () => {
  it("no existing intent → proceed + may write preparing", () => {
    expect(evaluateLocalIntent(null, CUR)).toMatchObject({ code: "no_existing_intent", proceed: true, writePreparing: true });
  });
  it("prior blocked with identical inputs (no artifact) → resume_local_exact (idempotent)", () => {
    expect(evaluateLocalIntent(rec({ status: "blocked" }), CUR)).toMatchObject({ code: "resume_local_exact", proceed: true, writePreparing: true });
  });
  it("prior blocked with CHANGED inputs (no artifact) → treated as a fresh prep", () => {
    expect(evaluateLocalIntent(rec({ status: "blocked", fingerprint: "OLD" }), CUR)).toMatchObject({ code: "no_existing_intent", proceed: true, writePreparing: true });
  });
  it("an unpersisted offer → prior_publish_in_progress BLOCK (must reconcile first)", () => {
    expect(evaluateLocalIntent(rec({ status: "offer_created_unpersisted", offerId: "O1" }), CUR)).toMatchObject({ code: "prior_publish_in_progress", proceed: false });
  });
  it("an in-flight offer, same inputs → prior_offer_created (proceed, but never re-prepare)", () => {
    expect(evaluateLocalIntent(rec({ status: "offer_created", offerId: "O1" }), CUR)).toMatchObject({ code: "prior_offer_created", proceed: true, writePreparing: false, offerId: "O1" });
  });
  it("an in-flight offer, CHANGED inputs → local_intent_inputs_changed BLOCK", () => {
    expect(evaluateLocalIntent(rec({ status: "offer_created", offerId: "O1", fingerprint: "OLD" }), CUR)).toMatchObject({ code: "local_intent_inputs_changed", proceed: false });
  });
  it("a published listing, same inputs → prior_published (proceed, never re-prepare)", () => {
    expect(evaluateLocalIntent(rec({ status: "published", offerId: "O1", listingId: "L9" }), CUR)).toMatchObject({ code: "prior_published", proceed: true, writePreparing: false, offerId: "O1", listingId: "L9" });
  });
  it("a published listing, CHANGED inputs → local_intent_inputs_changed BLOCK (never overwritten as a new prep)", () => {
    expect(evaluateLocalIntent(rec({ status: "published", offerId: "O1", listingId: "L9", fingerprint: "OLD" }), CUR)).toMatchObject({ code: "local_intent_inputs_changed", proceed: false });
  });
  it("a corrupt stored snapshot → invalid_intended_state BLOCK (never silently coerced)", () => {
    expect(evaluateLocalIntent(rec({ status: "preparing", intendedState: { version: 99 }, imageManifest: null }), CUR)).toMatchObject({ code: "invalid_intended_state", proceed: false });
  });
  it("a fingerprint-VERSION mismatch is not an exact resume", () => {
    expect(evaluateLocalIntent(rec({ status: "published", offerId: "O1", listingId: "L9", fingerprintVersion: 2 }), CUR)).toMatchObject({ code: "local_intent_inputs_changed", proceed: false });
  });
});
