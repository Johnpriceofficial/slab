// scripts/build-contract-snapshot.mjs
// Generates contracts/backend-capabilities.json from the OPERATIONS manifest in
// contracts/backend-operations.ts, and (optionally) copies the frontend-safe
// contract snapshot into the Lovable V2 repo. Run with bun:
//   bun scripts/build-contract-snapshot.mjs --mode canonical [--frontend <path>]
//   bun scripts/build-contract-snapshot.mjs --mode proposed  [--frontend <path>]
//
// MODES (never mixed):
//   canonical (default) - merged main only. Writes contracts/canonical/ and,
//                         with --frontend, src/integrations/backend/generated/.
//                         Gated (proposed) operations are EXCLUDED entirely.
//   proposed            - the unmerged review snapshot. Writes
//                         contracts/proposed/ and, with --frontend,
//                         src/integrations/backend/generated-proposed/.
//                         Never touches a canonical output path.
//
// DETERMINISM: the generator inserts no clock value. `generatedAt` is emitted
// only when SOURCE_DATE_EPOCH is supplied, so the same inputs always produce
// byte-identical outputs and checksums.
// Local-only tooling: no network, no database, no secrets.
//
// The generator is deliberately hostile to over-claiming. Everything it can
// derive from the tree it derives; everything it cannot derive it cross-checks
// against contracts/PROPOSED_STATE.json and refuses to emit on disagreement.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const { OPERATIONS, CONTRACT_VERSION } = await import(
  join(ROOT, "contracts/backend-operations.ts")
);

// ── Provenance ───────────────────────────────────────────────────────────────
// SIX distinct facts, never collapsed, so no consumer can mistake a proposed
// branch change for merged, merged for deployed, or deployed for verified.
const PROVENANCE = {
  backendRepository: "Johnpriceofficial/slab",

  // The commit whose source was READ to author this change.
  baseCommitInspected: "d8088f2a5379effc1fb82f2aea4b9d8c4e1d7271",

  // What `main` actually contains right now. `backendCommit` keeps its
  // historical name/meaning for existing consumers: the MERGED state.
  backendCommit: "d8088f2a5379effc1fb82f2aea4b9d8c4e1d7271",
  mergedMainCommit: "d8088f2a5379effc1fb82f2aea4b9d8c4e1d7271",
  migrationCount: 67,
  finalMigration: "20260906000000_account_deletion",

  // What THIS branch proposes on top of merged main.
  proposedBranch: "fix/atomic-confirmed-slab-save",
  // Filled in once the branch exists on the remote; null while it does not.
  proposedBranchCommit: "e1e5f8f0af871de01458a3c95d73f84e520e92cc",
  proposedMigrationCount: 68,
  proposedFinalMigration: "20260907000000_save_confirmed_slab_from_analysis",

  // Lifecycle. Each advances only when the step it names actually happened.
  liveVerificationState: "not-run-staging-verification-required",
  stagingVerifiedAt: null,
  liveCaseCount: 95,
  mergeState: "proposed-unmerged",
  mergeCommit: null,
  deploymentState: "not-deployed",
  deployedCommit: null,
  deployedAt: null,

  contractVersion: CONTRACT_VERSION,
};

// ── Mode ─────────────────────────────────────────────────────────────────────
const modeArg = process.argv.indexOf("--mode");
const MODE = modeArg === -1 ? "canonical" : process.argv[modeArg + 1];
if (MODE !== "canonical" && MODE !== "proposed") {
  throw new Error(`unknown --mode "${MODE}"; expected "canonical" or "proposed"`);
}

// ── Deterministic timestamp ──────────────────────────────────────────────────
// No current-clock value is ever inserted. With SOURCE_DATE_EPOCH the stamp is
// derived from it; without it the field is omitted altogether.
const SOURCE_DATE_EPOCH = process.env.SOURCE_DATE_EPOCH;
if (SOURCE_DATE_EPOCH !== undefined) {
  if (!/^\d+$/.test(SOURCE_DATE_EPOCH)) {
    throw new Error("SOURCE_DATE_EPOCH must be an integer number of seconds");
  }
  PROVENANCE.generatedAt = new Date(Number(SOURCE_DATE_EPOCH) * 1000).toISOString();
}

const fail = (msg) => {
  throw new Error(`contract snapshot refused (stale or over-claiming metadata): ${msg}`);
};

const promoted =
  PROVENANCE.mergeState === "merged" && PROVENANCE.deploymentState === "deployed";

// ── 1. Version string is DERIVED, never trusted ──────────────────────────────
// Shape: <semver>-merged-<short merged commit>-m<merged count>-proposed-m<proposed count>
const VERSION_RE =
  /^(\d+\.\d+\.\d+)-merged-([0-9a-f]{8})-m(\d+)-proposed-m(\d+)$/;
const parsed = VERSION_RE.exec(CONTRACT_VERSION);
if (!parsed) {
  fail(
    `CONTRACT_VERSION "${CONTRACT_VERSION}" does not match ` +
      "<semver>-merged-<8-hex>-m<merged count>-proposed-m<proposed count>",
  );
}
const [, semver, versionCommit, versionMerged, versionProposed] = parsed;
const expectedVersion =
  `${semver}-merged-${PROVENANCE.mergedMainCommit.slice(0, 8)}` +
  `-m${PROVENANCE.migrationCount}-proposed-m${PROVENANCE.proposedMigrationCount}`;
if (CONTRACT_VERSION !== expectedVersion) {
  fail(
    `CONTRACT_VERSION is "${CONTRACT_VERSION}" but provenance derives "${expectedVersion}" ` +
      `(commit ${versionCommit}, merged m${versionMerged}, proposed m${versionProposed})`,
  );
}
if (PROVENANCE.backendCommit !== PROVENANCE.mergedMainCommit) {
  fail("backendCommit must equal mergedMainCommit; it names the MERGED state");
}
if (PROVENANCE.migrationCount >= PROVENANCE.proposedMigrationCount) {
  fail("proposedMigrationCount must exceed the merged migrationCount");
}

// ── 2. Lifecycle fields must be internally consistent ────────────────────────
if (PROVENANCE.mergeState === "merged" && !PROVENANCE.mergeCommit) {
  fail("mergeState=merged requires a mergeCommit");
}
if (PROVENANCE.mergeState !== "merged" && PROVENANCE.mergeCommit) {
  fail("mergeCommit is set while mergeState is not 'merged'");
}
if (PROVENANCE.deploymentState === "deployed" && !PROVENANCE.deployedCommit) {
  fail("deploymentState=deployed requires a deployedCommit");
}
if (PROVENANCE.deploymentState === "deployed" && PROVENANCE.mergeState !== "merged") {
  fail("cannot be deployed while unmerged");
}
if (promoted && !PROVENANCE.liveVerificationState.startsWith("passed")) {
  fail("promotion requires liveVerificationState to record a passing live run");
}
if (PROVENANCE.liveVerificationState.startsWith("passed") && !PROVENANCE.stagingVerifiedAt) {
  fail("liveVerificationState claims a pass but stagingVerifiedAt is empty");
}

// ── 3. Migrations on disk must match the declared counts ─────────────────────
const migrationsDir = join(ROOT, "supabase/migrations");
const proposedFile = `${PROVENANCE.proposedFinalMigration}.sql`;
let proposedSql = "";
if (existsSync(migrationsDir)) {
  const sql = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (!sql.includes(proposedFile)) fail(`${proposedFile} is missing from supabase/migrations`);
  proposedSql = readFileSync(join(migrationsDir, proposedFile), "utf8");
  // Full history present (post-merge tree) — counts and tip must agree exactly.
  if (sql.length > 1) {
    if (sql.length !== PROVENANCE.proposedMigrationCount) {
      fail(
        `supabase/migrations holds ${sql.length} files but proposedMigrationCount is ${PROVENANCE.proposedMigrationCount}`,
      );
    }
    if (sql[sql.length - 1] !== proposedFile) {
      fail(`latest migration is ${sql[sql.length - 1]}, expected ${proposedFile}`);
    }
    if (sql[PROVENANCE.migrationCount - 1] !== `${PROVENANCE.finalMigration}.sql`) {
      fail(
        `merged tip is not ${PROVENANCE.finalMigration}.sql at position ${PROVENANCE.migrationCount}`,
      );
    }
  }
} else {
  fail("supabase/migrations is missing; cannot verify the proposed migration exists");
}

// ── 4. Proposed operations, DERIVED from the migration plus a declared list ──
// (a) Anything the proposed migration creates is, by definition, undeployed.
const derivedProposedResources = new Set(
  [...proposedSql.matchAll(/create\s+or\s+replace\s+function\s+public\.([a-z0-9_]+)\s*\(/gi)].map(
    (m) => `rpc:${m[1]}`,
  ),
);
if (derivedProposedResources.size === 0) {
  fail("no function could be derived from the proposed migration; the gate would be vacuous");
}

// (b) Operations whose *description* is corrected on this branch. These name a
// deployed resource, so nothing can derive them from SQL: they are declared
// here and cross-checked against PROPOSED_STATE.json below.
const DECLARED_CONTRACT_CORRECTIONS = new Set(["startSlabAnalysis"]);

const EXPECTED_UNPROMOTED_STATUS = {
  migration: "PROPOSED_NOT_DEPLOYED",
  correction: "PROPOSED_CONTRACT_CORRECTION",
};

const gatedOperations = new Map();
for (const op of OPERATIONS) {
  const backsProposedMigration = op.backendResource.some((r) => derivedProposedResources.has(r));
  const isCorrection = DECLARED_CONTRACT_CORRECTIONS.has(op.name);
  if (backsProposedMigration && isCorrection) {
    fail(`${op.name} is declared both migration-backed and contract-corrected; pick one`);
  }
  if (!backsProposedMigration && !isCorrection) {
    // Not gated — but it must not borrow a gate status either.
    if (op.status === "PROPOSED_NOT_DEPLOYED" || op.status === "PROPOSED_CONTRACT_CORRECTION") {
      fail(
        `${op.name} claims ${op.status} but is neither backed by the proposed migration nor a declared contract correction`,
      );
    }
    continue;
  }
  const kind = backsProposedMigration ? "migration" : "correction";
  gatedOperations.set(op.name, kind);
  const expected = EXPECTED_UNPROMOTED_STATUS[kind];
  if (!promoted && op.status !== expected) {
    fail(
      `${op.name} claims status ${op.status}; while mergeState=${PROVENANCE.mergeState} / ` +
        `deploymentState=${PROVENANCE.deploymentState} it must be ${expected}`,
    );
  }
  if (promoted && op.status !== "READY") {
    fail(`${op.name} is still ${op.status} after merge + deploy + live verification`);
  }
}
for (const name of DECLARED_CONTRACT_CORRECTIONS) {
  if (!gatedOperations.has(name)) {
    fail(`declared contract correction "${name}" is not present in OPERATIONS`);
  }
}

// ── 5. PROPOSED_STATE.json is the human twin of PROVENANCE — no drift ────────
const proposedStatePath = join(ROOT, "contracts/proposed/PROPOSED_STATE.json");
if (!existsSync(proposedStatePath)) {
  fail("contracts/proposed/PROPOSED_STATE.json is missing; provenance cannot be cross-checked");
}
const ps = JSON.parse(readFileSync(proposedStatePath, "utf8"));
for (const [key, expected] of [
  ["baseCommitInspected", PROVENANCE.baseCommitInspected],
  ["mergedMainCommit", PROVENANCE.mergedMainCommit],
  ["mergedMigrationCount", PROVENANCE.migrationCount],
  ["mergedFinalMigration", PROVENANCE.finalMigration],
  ["proposedBranch", PROVENANCE.proposedBranch],
  ["proposedBranchCommit", PROVENANCE.proposedBranchCommit],
  ["proposedMigration", PROVENANCE.proposedFinalMigration],
  ["proposedMigrationCount", PROVENANCE.proposedMigrationCount],
  ["proposedContractVersion", CONTRACT_VERSION],
  ["mergeState", PROVENANCE.mergeState],
  ["mergeCommit", PROVENANCE.mergeCommit],
  ["deploymentState", PROVENANCE.deploymentState],
  ["deployedCommit", PROVENANCE.deployedCommit],
  ["deployedAt", PROVENANCE.deployedAt],
  ["liveVerificationState", PROVENANCE.liveVerificationState],
  ["stagingVerifiedAt", PROVENANCE.stagingVerifiedAt],
]) {
  if (ps[key] !== expected) {
    fail(
      `PROPOSED_STATE.json ${key}=${JSON.stringify(ps[key])} but provenance says ${JSON.stringify(expected)}`,
    );
  }
}
if ((ps.liveIntegrationTests?.caseCount ?? null) !== PROVENANCE.liveCaseCount) {
  fail(
    `PROPOSED_STATE.json liveIntegrationTests.caseCount=${ps.liveIntegrationTests?.caseCount} but provenance says ${PROVENANCE.liveCaseCount}`,
  );
}
// Every gated operation must be listed with the same status in both places.
const statusMap = ps.operationStatus ?? {};
for (const [name, kind] of gatedOperations) {
  const op = OPERATIONS.find((o) => o.name === name);
  const declared = statusMap[name];
  if (declared === undefined) {
    fail(`PROPOSED_STATE.json operationStatus is missing gated operation "${name}" (${kind})`);
  }
  if (declared !== op.status) {
    fail(
      `PROPOSED_STATE.json operationStatus.${name}=${JSON.stringify(declared)} but the manifest says ${JSON.stringify(op.status)}`,
    );
  }
}
for (const name of Object.keys(statusMap)) {
  const op = OPERATIONS.find((o) => o.name === name);
  if (!op) fail(`PROPOSED_STATE.json operationStatus names unknown operation "${name}"`);
  if (statusMap[name] !== op.status) {
    fail(`PROPOSED_STATE.json operationStatus.${name} disagrees with the manifest`);
  }
}

// ── capability artifact (generated, machine-readable) ────────────────────────
// Canonical mode publishes ONLY merged-main operations. A proposed operation
// may never appear in a canonical artifact, and a canonical artifact may never
// be written from proposed metadata.
const emittedOperations = OPERATIONS.filter(
  (op) => MODE === "proposed" || !gatedOperations.has(op.name),
);
if (MODE === "canonical") {
  for (const op of emittedOperations) {
    if (op.status === "PROPOSED_NOT_DEPLOYED" || op.status === "PROPOSED_CONTRACT_CORRECTION") {
      fail(`canonical mode refuses to publish proposed operation "${op.name}"`);
    }
  }
}

const canonicalProvenance = {
  backendRepository: PROVENANCE.backendRepository,
  backendCommit: PROVENANCE.backendCommit,
  mergedMainCommit: PROVENANCE.mergedMainCommit,
  migrationCount: PROVENANCE.migrationCount,
  finalMigration: PROVENANCE.finalMigration,
  contractVersion: CONTRACT_VERSION,
  ...(PROVENANCE.generatedAt ? { generatedAt: PROVENANCE.generatedAt } : {}),
};

const capabilities = {
  $schema: "./backend-capabilities.schema.json",
  snapshotMode: MODE,
  provenance: MODE === "canonical" ? canonicalProvenance : PROVENANCE,
  operations: emittedOperations.map((op) => ({
    operation: op.name,
    domain: op.domain,
    backendResource: op.backendResource,
    role: op.role,
    reads: op.reads,
    writes: op.writes,
    authorization: op.authorization,
    classification: op.classification,
    integration: op.status,
    idempotent: op.idempotent,
    retriable: op.retriable,
    sideEffects: op.sideEffects,
    ...(op.notes ? { notes: op.notes } : {}),
  })),
};
const capabilitiesJson = JSON.stringify(capabilities, null, 2) + "\n";

const OUT_DIR = join(ROOT, MODE === "canonical" ? "contracts/canonical" : "contracts/proposed");
const OUT_FILE =
  MODE === "canonical" ? "backend-capabilities.json" : "backend-capabilities.proposed.json";
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, OUT_FILE), capabilitiesJson);
console.log(
  `[${MODE}] wrote ${OUT_DIR.replace(ROOT, "")}/${OUT_FILE} ` +
    `(${capabilities.operations.length} operations, ${gatedOperations.size} gated: ` +
    `${[...gatedOperations.keys()].join(", ") || "none"})`,
);
if (MODE === "proposed") {
  console.log(
    [
      "PROMOTION ORDER (do not reorder):",
      " 1. Create the review branch and draft pull request.",
      " 2. Run clean install, typecheck, lint, format and unit tests in PR CI.",
      " 3. Apply the proposed migration to an ISOLATED STAGING database only.",
      " 4. Run the complete live integration suite with zero skips.",
      " 5. Record the staging verification commit, timestamp and results.",
      " 6. Review and merge the pull request.",
      " 7. Deploy the merged migration through the controlled deployment process.",
      " 8. Run the approved deployed verification subset.",
      " 9. Set operation status to READY only after that verification passes.",
      "10. Regenerate the canonical frontend snapshot (--mode canonical).",
      "11. Connect the frontend in a separate milestone.",
    ].join("\n"),
  );
}

// ── frontend-safe snapshot ───────────────────────────────────────────────────
const frontendArg = process.argv.indexOf("--frontend");
if (frontendArg !== -1) {
  const feRoot = process.argv[frontendArg + 1];
  if (!feRoot) throw new Error("--frontend requires a path");
  const genDir = join(
    feRoot,
    MODE === "canonical"
      ? "src/integrations/backend/generated"
      : "src/integrations/backend/generated-proposed",
  );
  mkdirSync(genDir, { recursive: true });

  const sha = (buf) => createHash("sha256").update(buf).digest("hex");
  const files = [
    "contracts/database.types.ts",
    "contracts/backend-operations.ts",
    "contracts/error-codes.ts",
  ];
  const manifest = [];
  for (const rel of files) {
    const content = readFileSync(join(ROOT, rel));
    const base = rel.split("/").pop();
    writeFileSync(join(genDir, base), content);
    manifest.push({ file: base, sha256: sha(content) });
  }
  writeFileSync(join(genDir, OUT_FILE), capabilitiesJson);
  manifest.push({ file: OUT_FILE, sha256: sha(capabilitiesJson) });

  // Every artifact file must carry a checksum; a snapshot with an unchecksummed
  // file cannot be verified by the frontend release gate.
  for (const expectedFile of [
    "database.types.ts",
    "backend-operations.ts",
    "error-codes.ts",
    OUT_FILE,
  ]) {
    if (!manifest.some((m) => m.file === expectedFile)) {
      fail(`frontend snapshot is missing a checksum for ${expectedFile}`);
    }
  }

  const versionDoc = [
    `CONTRACT_VERSION=${CONTRACT_VERSION}`,
    `BACKEND_REPOSITORY=${PROVENANCE.backendRepository}`,
    `BACKEND_COMMIT=${PROVENANCE.backendCommit}`,
    // Aliases consumed by the frontend release gates, which distinguish the
    // commit the artifact declares from the commit the frontend was
    // reconciled against.
    `MANIFEST_DECLARED_COMMIT=${PROVENANCE.backendCommit}`,
    `INSPECTED_COMMIT=${PROVENANCE.mergedMainCommit}`,
    `BASE_COMMIT_INSPECTED=${PROVENANCE.baseCommitInspected}`,
    `MERGED_MAIN_COMMIT=${PROVENANCE.mergedMainCommit}`,
    `MIGRATION_COUNT=${PROVENANCE.migrationCount}`,
    `FINAL_MIGRATION=${PROVENANCE.finalMigration}`,
    `PROPOSED_BRANCH=${PROVENANCE.proposedBranch}`,
    `PROPOSED_BRANCH_COMMIT=${PROVENANCE.proposedBranchCommit ?? ""}`,
    `PROPOSED_MIGRATION_COUNT=${PROVENANCE.proposedMigrationCount}`,
    `PROPOSED_FINAL_MIGRATION=${PROVENANCE.proposedFinalMigration}`,
    `MERGE_STATE=${PROVENANCE.mergeState}`,
    `MERGE_COMMIT=${PROVENANCE.mergeCommit ?? ""}`,
    `DEPLOYMENT_STATE=${PROVENANCE.deploymentState}`,
    `DEPLOYED_COMMIT=${PROVENANCE.deployedCommit ?? ""}`,
    `DEPLOYED_AT=${PROVENANCE.deployedAt ?? ""}`,
    `LIVE_VERIFICATION_STATE=${PROVENANCE.liveVerificationState}`,
    `STAGING_VERIFIED_AT=${PROVENANCE.stagingVerifiedAt ?? ""}`,
    `LIVE_CASE_COUNT=${PROVENANCE.liveCaseCount}`,
    ...(PROVENANCE.generatedAt ? [`GENERATED_AT=${PROVENANCE.generatedAt}`] : []),
    `SNAPSHOT_MODE=${MODE}`,
    ...manifest.map((m) => `SHA256_${m.file.replace(/[^A-Za-z0-9]/g, "_")}=${m.sha256}`),
    "",
  ].join("\n");
  writeFileSync(join(genDir, "CONTRACT_VERSION"), versionDoc);
  console.log(
    `[${MODE}] wrote frontend snapshot -> ${genDir} (${manifest.length} files + CONTRACT_VERSION)`,
  );
}
