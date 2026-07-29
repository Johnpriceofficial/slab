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

  it("does not call the corrected analyze-slab contract production-ready", () => {
    const op = byName.get("startSlabAnalysis")!;
    // The handler is deployed; this manifest's corrected account of it is not
    // yet verified against it, so the operation must not claim READY.
    expect(op.status).toBe("PROPOSED_CONTRACT_CORRECTION");
    expect(op.notes ?? "").toContain("Not READY");
    expect(proposedState.operationStatus.startSlabAnalysis).toBe("PROPOSED_CONTRACT_CORRECTION");
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

  it("exposes the atomic confirmed-save RPC as idempotent and retriable, but NOT deployed", () => {
    const op = byName.get("saveConfirmedSlabFromAnalysis")!;
    expect(op.backendResource).toEqual(["rpc:save_confirmed_slab_from_analysis"]);
    expect(op.writes).toBe(true);
    expect(op.idempotent).toBe(true);
    expect(op.retriable).toBe(true);
    expect(op.classification).toBe("BROWSER_CUSTOMER_SAFE");
    // Truthful state: the migration lives on an unmerged branch.
    expect(op.status).toBe("PROPOSED_NOT_DEPLOYED");
    expect(op.notes ?? "").toContain("not merged, not deployed");
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
    expect(analysis.status).toBe("PROPOSED_NOT_DEPLOYED");
    const start = byName.get("startSlabAnalysis")!;
    expect(start.backendResource).toEqual(["edge:analyze-slab"]);
    expect(start.status).toBe("PROPOSED_CONTRACT_CORRECTION");
  });

  it("carries a version string that separates merged from proposed migrations", () => {
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+-merged-[0-9a-f]{8}-m\d+-proposed-m\d+$/);
    expect(CONTRACT_VERSION).toBe("1.3.0-merged-d8088f2a-m67-proposed-m68");
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
    expect(p.baseCommitInspected).toBe("d8088f2a5379effc1fb82f2aea4b9d8c4e1d7271");
    expect(p.mergedMainCommit).toBe("d8088f2a5379effc1fb82f2aea4b9d8c4e1d7271");
    expect(migrationCount).toBe(67);
    expect(finalMigration).toBe("20260906000000_account_deletion");
    expect(proposedMigrationCount).toBe(68);
    expect(proposedFinalMigration).toBe("20260907000000_save_confirmed_slab_from_analysis");
    expect(p.proposedBranchCommit).toBeNull();
    expect(p.mergeState).toBe("proposed-unmerged");
    expect(p.mergeCommit).toBeNull();
    expect(p.deploymentState).toBe("not-deployed");
    expect(p.deployedCommit).toBeNull();
    expect(p.deployedAt).toBeNull();
    expect(p.liveVerificationState).toBe("not-run-staging-verification-required");
    expect(p.stagingVerifiedAt).toBeNull();
  });

  it("declares no operation READY that depends on the unmerged branch", () => {
    for (const op of OPERATIONS) {
      if (op.backendResource.includes("rpc:save_confirmed_slab_from_analysis")) {
        expect(op.status).not.toBe("READY");
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

  it("declares the live case count that the suite actually contains", () => {
    expect(proposedState.liveIntegrationTests.caseCount).toBe(95);
    expect(proposedState.liveIntegrationTests.caseCount).toBeGreaterThanOrEqual(66);
    expect(proposedState.liveIntegrationTests.state).toBe(
      "WRITTEN BUT NOT RUN — STAGING VERIFICATION REQUIRED",
    );
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
