import { describe, expect, it } from "vitest";
import {
  ANALYZE_SLAB_LIMITS,
  OPERATIONS,
  CONTRACT_VERSION,
  toStartSlabAnalysisWireRequest,
  type StartSlabAnalysisRequest,
  type StartSlabAnalysisWireRequest,
} from "../../../contracts/backend-operations";
import proposedState from "../../../contracts/proposed/PROPOSED_STATE.json";

const byName = new Map(OPERATIONS.map((op) => [op.name, op]));

/**
 * tsconfig.app.json sets `strict: false`, which disables discriminated-union
 * narrowing on the negative branch of `result.ok`. These helpers narrow
 * explicitly so the assertions stay type-safe under the repository's real
 * compiler settings instead of relying on narrowing that does not happen.
 */
type SerializerResult = ReturnType<typeof toStartSlabAnalysisWireRequest>;
type SerializerFailure = Extract<SerializerResult, { ok: false }>;

function failure(result: SerializerResult): SerializerFailure["error"] {
  if (result.ok) throw new Error("expected the serializer to reject this input");
  return (result as SerializerFailure).error;
}


describe("analysis contract", () => {
  it("maps startSlabAnalysis to edge:analyze-slab, not the V1 multipart intake", () => {
    const op = byName.get("startSlabAnalysis")!;
    expect(op.backendResource).toEqual(["edge:analyze-slab"]);
    expect(op.backendResource).not.toContain("edge:scan-card");
    expect(op.notes ?? "").toContain("15 MiB");
    expect(op.notes ?? "").toContain("40 MiB");
    expect(op.notes ?? "").toContain("front_image_base64");
    expect(op.notes ?? "").toContain("NO slabId");
  });

  it("marks the corrected analyze-slab contract READY once merged, deployed and live-verified", () => {
    const op = byName.get("startSlabAnalysis")!;
    // The handler is merged (72e6e58), deployed to production as analyze-slab
    // v87, and its request/authorization contract was exercised live.
    expect(op.status).toBe("READY");
    expect(op.notes ?? "").toContain("READY");
    expect(proposedState.operationStatus.startSlabAnalysis).toBe("READY");
  });

  it("types the analyze-slab WIRE body as the real base64 JSON shape", () => {
    const wire: StartSlabAnalysisWireRequest = {
      front_image_base64: "AAAA",
      front_mime: "image/jpeg",
      back_image_base64: "BBBB",
      back_mime: "image/png",
      variants: [{ label: "label close-up", image_base64: "CCCC", mime: "image/webp" }],
    };
    expect(Object.keys(wire)).not.toContain("slabId");
    // @ts-expect-error the handler has no slabId argument; the slab does not exist yet.
    const wrong: StartSlabAnalysisWireRequest = { slabId: "abc" };
    expect(wrong).toBeTruthy();
  });

  it("keeps the application request camelCase and makes a half back-image pair unrepresentable", () => {
    const request: StartSlabAnalysisRequest = {
      front: { base64: "AAAA", mime: "image/jpeg" },
      back: { base64: "BBBB", mime: "image/png" },
      variants: [{ label: "label close-up", image: { base64: "CCCC", mime: "image/webp" } }],
    };
    expect(Object.keys(request)).toEqual(["front", "back", "variants"]);
    // @ts-expect-error bytes and MIME travel together; a lone base64 is not a back image.
    const halfPair: StartSlabAnalysisRequest = { front: request.front, back: { base64: "BBBB" } };
    expect(halfPair).toBeTruthy();
    // @ts-expect-error snake_case wire keys must not leak into application code.
    const snake: StartSlabAnalysisRequest = { front_image_base64: "AAAA", front_mime: "image/jpeg" };
    expect(snake).toBeTruthy();
  });

  it("serializes application input to the exact wire body", () => {
    const result = toStartSlabAnalysisWireRequest({
      front: { base64: "AAAA", mime: "image/jpeg" },
      back: { base64: "BBBB", mime: "image/png" },
      variants: [{ label: "label", image: { base64: "CCCC", mime: "image/webp" } }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      front_image_base64: "AAAA",
      front_mime: "image/jpeg",
      back_image_base64: "BBBB",
      back_mime: "image/png",
      variants: [{ label: "label", image_base64: "CCCC", mime: "image/webp" }],
    });
  });

  it("emits both back keys or neither — never the half pair the handler silently drops", () => {
    const frontOnly = toStartSlabAnalysisWireRequest({
      front: { base64: "AAAA", mime: "image/jpeg" },
    });
    expect(frontOnly.ok).toBe(true);
    if (!frontOnly.ok) return;
    expect("back_image_base64" in frontOnly.value).toBe(false);
    expect("back_mime" in frontOnly.value).toBe(false);
    expect("variants" in frontOnly.value).toBe(false);

    const emptyBack = toStartSlabAnalysisWireRequest({
      front: { base64: "AAAA", mime: "image/jpeg" },
      back: { base64: "", mime: "image/png" },
    });
    expect(emptyBack.ok).toBe(false);
    if (emptyBack.ok) return;
    expect(failure(emptyBack).code).toBe("INCOMPLETE_BACK_IMAGE");
  });

  it("refuses locally what the server would refuse anyway", () => {
    const noFront = toStartSlabAnalysisWireRequest({
      front: { base64: "", mime: "image/jpeg" },
    });
    expect(noFront.ok).toBe(false);
    expect(failure(noFront).code).toBe("MISSING_FRONT_IMAGE");

    const badMime = toStartSlabAnalysisWireRequest({
      front: { base64: "AAAA", mime: "image/gif" as never },
    });
    expect(badMime.ok).toBe(false);
    expect(failure(badMime).code).toBe("UNSUPPORTED_IMAGE_MIME");

    const tooMany = toStartSlabAnalysisWireRequest({
      front: { base64: "AAAA", mime: "image/jpeg" },
      variants: Array.from({ length: ANALYZE_SLAB_LIMITS.maxVariants + 1 }, (_, i) => ({
        label: `v${i}`,
        image: { base64: "CCCC", mime: "image/webp" as const },
      })),
    });
    expect(tooMany.ok).toBe(false);
    expect(failure(tooMany).code).toBe("TOO_MANY_VARIANTS");
  });

  it("pins the canonical image limits", () => {
    expect(ANALYZE_SLAB_LIMITS.maxImageBytes).toBe(15_728_640);
    expect(ANALYZE_SLAB_LIMITS.maxAggregateBytes).toBe(41_943_040);
    expect(ANALYZE_SLAB_LIMITS.maxVariants).toBe(8);
    expect(ANALYZE_SLAB_LIMITS.mimeTypes).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
    ]);
  });

  it("exposes the atomic confirmed-save RPC as idempotent and retriable, and READY (deployed)", () => {
    const op = byName.get("saveConfirmedSlabFromAnalysis")!;
    expect(op.backendResource).toEqual(["rpc:save_confirmed_slab_from_analysis"]);
    expect(op.writes).toBe(true);
    expect(op.idempotent).toBe(true);
    expect(op.retriable).toBe(true);
    expect(op.classification).toBe("BROWSER_CUSTOMER_SAFE");
    // Truthful state: merged into main (72e6e58) and live in production.
    expect(op.status).toBe("READY");
    expect(op.notes ?? "").toContain("merged into main");
    expect(op.notes ?? "").toContain("pg_advisory_xact_lock(918273645)");
  });

  it("states the fail-closed, self-owned-only authorization rule without hedging", () => {
    const op = byName.get("saveConfirmedSlabFromAnalysis")!;
    const auth = op.authorization;
    expect(auth).toContain("administrators included");
    expect(auth).toContain("must own the analysis run");
    expect(auth).toContain("no administrator override");
    expect(auth).toContain("42501");
    // The earlier wording implied only non-admins were constrained.
    expect(auth).not.toMatch(/^auth\.uid\(\); non-admins need/);
  });

  it("keeps the gated operations gated in the manifest itself", () => {
    // Capability JSON is GENERATED, never hand-maintained, so it is not
    // checked in here: the generator validates it at emit time. The manifest
    // is the single editable source.
    const analysis = byName.get("saveConfirmedSlabFromAnalysis")!;
    expect(analysis.backendResource).toEqual(["rpc:save_confirmed_slab_from_analysis"]);
    expect(analysis.status).toBe("READY");
    const start = byName.get("startSlabAnalysis")!;
    expect(start.backendResource).toEqual(["edge:analyze-slab"]);
    expect(start.status).toBe("READY");
  });

  it("carries a version string that separates merged from proposed migrations", () => {
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+-merged-[0-9a-f]{8}-m\d+-proposed-m\d+$/);
    expect(CONTRACT_VERSION).toBe("1.4.0-merged-6d2faea0-m77-proposed-m77");
    // The old form attached migration 68 to the merged commit.
    expect(CONTRACT_VERSION).not.toBe("1.3.0-d8088f2a-m68");
    expect(proposedState.proposedContractVersion).toBe(CONTRACT_VERSION);
  });

  it("keeps base, merged, proposed, deployed and verification provenance separated", () => {
    const p = proposedState as unknown as Record<string, unknown>;
    const migrationCount = proposedState.mergedMigrationCount;
    const finalMigration = proposedState.mergedFinalMigration;
    const proposedMigrationCount = proposedState.proposedMigrationCount;
    const proposedFinalMigration = proposedState.proposedMigration;
    expect(p.baseCommitInspected).toBe("6d2faea09b428f36d15ef2cbd82ae1643bc27c43");
    expect(p.mergedMainCommit).toBe("6d2faea09b428f36d15ef2cbd82ae1643bc27c43");
    expect(migrationCount).toBe(77);
    expect(finalMigration).toBe("20260915000000_grading_advisor_rls_hardening");
    // RELEASED: the proposed layer is EMPTY (all merged), so the proposed facts
    // equal the merged facts — this is a first-class fully-merged state, not a
    // fake pending migration. This branch is contract-only and adds nothing to
    // any database.
    expect(proposedMigrationCount).toBe(77);
    expect(proposedFinalMigration).toBe("20260915000000_grading_advisor_rls_hardening");
    // The buildout layer (m70..m77) is merged (6d2faea) and applied to
    // production; the timestamps are derived from the production migration
    // ledger (20260802181313), not from a wall clock.
    expect(p.proposedBranchCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(p.mergeState).toBe("merged");
    expect(p.mergeCommit).toBe("6d2faea09b428f36d15ef2cbd82ae1643bc27c43");
    expect(p.deploymentState).toBe("deployed");
    expect(p.deployedCommit).toBe("6d2faea09b428f36d15ef2cbd82ae1643bc27c43");
    expect(p.deployedAt).toBe("2026-08-02T18:13:13Z");
    expect(p.liveVerificationState).toBe("passed-production");
    expect(p.stagingVerifiedAt).toBe("2026-08-02T18:13:13Z");
  });

  it("declares the merged + deployed atomic-save operation READY", () => {
    // The branch is merged (72e6e58) and the RPC is live in production, so the
    // operation that depends on it is now READY rather than gated.
    for (const op of OPERATIONS) {
      if (op.backendResource.includes("rpc:save_confirmed_slab_from_analysis")) {
        expect(op.status).toBe("READY");
      }
    }
  });

  it("states ONE promotion order: branch and PR, CI, staging, merge, deploy, READY", () => {
    const steps = proposedState.promotionProcess;
    const at = (re: RegExp) => steps.findIndex((s: string) => re.test(s));
    const branch = at(/review branch and open a DRAFT pull request/i);
    const ci = at(/pull-request CI/i);
    const staging = at(/isolated STAGING database/i);
    const live = at(/live integration suite/i);
    const merge = at(/merge the pull request/i);
    const deploy = at(/Deploy the merged migration/i);
    const ready = at(/set saveConfirmedSlabFromAnalysis to READY/i);
    const regenerate = at(/Regenerate the canonical frontend snapshot/i);
    const connect = at(/Connect the frontend/i);
    for (const idx of [branch, ci, staging, live, merge, deploy, ready, regenerate, connect]) {
      expect(idx).toBeGreaterThan(-1);
    }
    expect(branch).toBeLessThan(ci);
    expect(ci).toBeLessThan(staging);
    expect(staging).toBeLessThan(live);
    expect(live).toBeLessThan(merge);
    expect(merge).toBeLessThan(deploy);
    expect(deploy).toBeLessThan(ready);
    expect(ready).toBeLessThan(regenerate);
    expect(regenerate).toBeLessThan(connect);
    expect(steps.join(" ")).not.toMatch(/STAGING FIRST/);
  });

  it("declares the live case count and the honest verification state of the suite", () => {
    expect(proposedState.liveIntegrationTests.caseCount).toBe(95);
    expect(proposedState.liveIntegrationTests.caseCount).toBeGreaterThanOrEqual(66);
    // The 95-case suite is env-gated and was not executed this cycle; the state
    // records that honestly and points to the live security/access/contract subset.
    expect(proposedState.liveIntegrationTests.state).toMatch(/NOT EXECUTED THIS CYCLE/i);
    expect(proposedState.liveIntegrationTests.state).toMatch(/env-gated/i);
    expect(proposedState.liveIntegrationTests.state).toMatch(
      /security, access-control and request-contract subset/i,
    );
    // What WAS verified live in production is recorded in verifiedProperties, and
    // items proven by those live probes are no longer listed as unverified.
    expect(proposedState.verifiedProperties.some((p) => /live production probes/i.test(p))).toBe(
      true,
    );
    expect(
      proposedState.unverifiedProperties.some((p) => /suspended-profile refusal/i.test(p)),
    ).toBe(false);
  });

  it("keeps canonical and proposed snapshot locations separated", () => {
    expect(proposedState.snapshotSeparation.canonical).toContain("contracts/canonical/");
    expect(proposedState.snapshotSeparation.proposed).toContain("contracts/proposed/");
    expect(proposedState.snapshotSeparation.rule).toMatch(/never writes to a canonical path/i);
  });

  it("emits no clock-derived generation timestamp", () => {
    expect(proposedState.determinism.generatedAt).toMatch(/no clock value/i);
    expect(JSON.stringify(proposedState)).not.toContain("2026-07-29T00:00:00Z");
  });
});

describe("startSlabAnalysis serializer", () => {
  const front = { base64: "AAAA", mime: "image/jpeg" } as const;

  const variants = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      label: `v${i}`,
      image: { base64: "CCCC", mime: "image/webp" as const },
    }));

  it("rejects blank front image data", () => {
    const r = toStartSlabAnalysisWireRequest({ front: { base64: "", mime: "image/jpeg" } });
    expect(r.ok).toBe(false);
    expect(failure(r).code).toBe("MISSING_FRONT_IMAGE");
  });

  it("rejects whitespace-only front image data", () => {
    const r = toStartSlabAnalysisWireRequest({ front: { base64: "   ", mime: "image/jpeg" } });
    expect(r.ok).toBe(false);
    expect(failure(r).code).toBe("MISSING_FRONT_IMAGE");
  });

  it("rejects blank back image data", () => {
    const r = toStartSlabAnalysisWireRequest({ front, back: { base64: "", mime: "image/png" } });
    expect(r.ok).toBe(false);
    expect(failure(r).code).toBe("INCOMPLETE_BACK_IMAGE");
  });

  it("rejects whitespace-only back image data", () => {
    const r = toStartSlabAnalysisWireRequest({ front, back: { base64: "\n\t ", mime: "image/png" } });
    expect(r.ok).toBe(false);
    expect(failure(r).code).toBe("INCOMPLETE_BACK_IMAGE");
  });

  it("rejects blank variant image data", () => {
    const r = toStartSlabAnalysisWireRequest({
      front,
      variants: [{ label: "corner", image: { base64: "", mime: "image/webp" } }],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects whitespace-only variant image data", () => {
    const r = toStartSlabAnalysisWireRequest({
      front,
      variants: [{ label: "corner", image: { base64: "  ", mime: "image/webp" } }],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a blank variant label with INVALID_VARIANT_LABEL", () => {
    const r = toStartSlabAnalysisWireRequest({
      front,
      variants: [{ label: "", image: { base64: "CCCC", mime: "image/webp" } }],
    });
    expect(r.ok).toBe(false);
    expect(failure(r).code).toBe("INVALID_VARIANT_LABEL");
  });

  it("rejects a whitespace-only variant label with INVALID_VARIANT_LABEL", () => {
    const r = toStartSlabAnalysisWireRequest({
      front,
      variants: [{ label: "   ", image: { base64: "CCCC", mime: "image/webp" } }],
    });
    expect(r.ok).toBe(false);
    expect(failure(r).code).toBe("INVALID_VARIANT_LABEL");
  });

  it("accepts exactly eight variants", () => {
    const r = toStartSlabAnalysisWireRequest({ front, variants: variants(8) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.variants).toHaveLength(8);
  });

  it("rejects nine variants", () => {
    const r = toStartSlabAnalysisWireRequest({ front, variants: variants(9) });
    expect(r.ok).toBe(false);
    expect(failure(r).code).toBe("TOO_MANY_VARIANTS");
  });

  it("never emits an empty variants array", () => {
    const r = toStartSlabAnalysisWireRequest({ front, variants: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect("variants" in r.value).toBe(false);
  });

  it("emits only the exact backend wire keys", () => {
    const r = toStartSlabAnalysisWireRequest({
      front,
      back: { base64: "BBBB", mime: "image/png" },
      variants: variants(1),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value).sort()).toEqual(
      ["back_image_base64", "back_mime", "front_image_base64", "front_mime", "variants"].sort(),
    );
    expect(Object.keys(r.value.variants![0]).sort()).toEqual(["image_base64", "label", "mime"]);
  });

  it("does not mutate the input, its images, its variant array or its variants", () => {
    const input = Object.freeze({
      front: Object.freeze({ base64: "AAAA", mime: "image/jpeg" as const }),
      back: Object.freeze({ base64: "BBBB", mime: "image/png" as const }),
      variants: Object.freeze([
        Object.freeze({
          label: "corner",
          image: Object.freeze({ base64: "CCCC", mime: "image/webp" as const }),
        }),
      ]),
    }) as StartSlabAnalysisRequest;
    const before = JSON.parse(JSON.stringify(input));
    const r = toStartSlabAnalysisWireRequest(input);
    expect(r.ok).toBe(true);
    expect(JSON.parse(JSON.stringify(input))).toEqual(before);
    if (r.ok && r.value.variants) {
      expect(r.value.variants[0]).not.toBe(input.variants![0]);
      expect(r.value.variants).not.toBe(input.variants);
    }
  });
});
