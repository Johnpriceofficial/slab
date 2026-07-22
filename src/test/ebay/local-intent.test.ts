import { describe, it, expect } from "vitest";
import { evaluateLocalIntent, type LocalIntentRecord } from "../../../supabase/functions/_shared/ebay-local-intent";

const CUR = { fingerprint: "FP", fingerprintVersion: 3 };
const rec = (over: Partial<LocalIntentRecord> = {}): LocalIntentRecord => ({
  status: "preparing", fingerprint: "FP", fingerprintVersion: 3, offerId: null, listingId: null, ...over,
});

describe("evaluateLocalIntent — pre-read gate (snapshot already verified upstream)", () => {
  it("no existing intent → proceed + may write preparing", () => {
    expect(evaluateLocalIntent(null, CUR)).toMatchObject({ code: "no_existing_intent", proceed: true, writePreparing: true });
  });
  it("prior blocked, identical inputs, no artifact → resume_local_exact", () => {
    expect(evaluateLocalIntent(rec({ status: "blocked" }), CUR)).toMatchObject({ code: "resume_local_exact", proceed: true, writePreparing: true });
  });
  it("prior blocked, changed inputs, no artifact → fresh prep", () => {
    expect(evaluateLocalIntent(rec({ status: "blocked", fingerprint: "OLD" }), CUR)).toMatchObject({ code: "no_existing_intent", proceed: true, writePreparing: true });
  });
  it("unpersisted offer → prior_publish_in_progress BLOCK", () => {
    expect(evaluateLocalIntent(rec({ status: "offer_created_unpersisted", offerId: "O1" }), CUR)).toMatchObject({ code: "prior_publish_in_progress", proceed: false });
  });
  it("in-flight offer, same inputs → prior_offer_created (never re-prepare)", () => {
    expect(evaluateLocalIntent(rec({ status: "offer_created", offerId: "O1" }), CUR)).toMatchObject({ code: "prior_offer_created", proceed: true, writePreparing: false, offerId: "O1" });
  });
  it("in-flight offer, changed inputs → local_intent_inputs_changed BLOCK", () => {
    expect(evaluateLocalIntent(rec({ status: "offer_created", offerId: "O1", fingerprint: "OLD" }), CUR)).toMatchObject({ code: "local_intent_inputs_changed", proceed: false });
  });
  it("published, same inputs → prior_published (never re-prepare)", () => {
    expect(evaluateLocalIntent(rec({ status: "published", offerId: "O1", listingId: "L9" }), CUR)).toMatchObject({ code: "prior_published", proceed: true, writePreparing: false, offerId: "O1", listingId: "L9" });
  });
  it("published, changed inputs → local_intent_inputs_changed BLOCK (never overwritten)", () => {
    expect(evaluateLocalIntent(rec({ status: "published", offerId: "O1", listingId: "L9", fingerprint: "OLD" }), CUR)).toMatchObject({ code: "local_intent_inputs_changed", proceed: false });
  });
  it("fingerprint-VERSION mismatch is not an exact resume", () => {
    expect(evaluateLocalIntent(rec({ status: "published", offerId: "O1", listingId: "L9", fingerprintVersion: 2 }), CUR)).toMatchObject({ code: "local_intent_inputs_changed", proceed: false });
  });
});
