// scripts/build-contract-snapshot.mjs
// Generates contracts/backend-capabilities.json from the OPERATIONS manifest in
// contracts/backend-operations.ts, and (optionally) copies the frontend-safe
// contract snapshot into the Lovable V2 repo. Run with bun:
//   bun scripts/build-contract-snapshot.mjs [--frontend <path-to-slab-scribe-pro>]
// Local-only tooling: no network, no database, no secrets.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const { OPERATIONS, CONTRACT_VERSION } = await import(
  join(ROOT, "contracts/backend-operations.ts")
);

const PROVENANCE = {
  backendRepository: "Johnpriceofficial/slab",
  backendCommit: "ba3953fdb68c31435c7dac732f67d8d53aa2adcb",
  migrationCount: 65,
  finalMigration: "20260904000000_slab_deletion_tombstones_rls",
  contractVersion: CONTRACT_VERSION,
  generatedAt: "2026-07-27T00:00:00Z", // stamped at generation; stable within a version
};

// ── backend-capabilities.json (generated, machine-readable) ──────────────────
const capabilities = {
  $schema: "./backend-capabilities.schema.json",
  provenance: PROVENANCE,
  operations: OPERATIONS.map((op) => ({
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
writeFileSync(join(ROOT, "contracts/backend-capabilities.json"), capabilitiesJson);
console.log(`wrote contracts/backend-capabilities.json (${capabilities.operations.length} operations)`);

// ── frontend-safe snapshot ───────────────────────────────────────────────────
const frontendArg = process.argv.indexOf("--frontend");
if (frontendArg !== -1) {
  const feRoot = process.argv[frontendArg + 1];
  if (!feRoot) throw new Error("--frontend requires a path");
  const genDir = join(feRoot, "src/integrations/backend/generated");
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
  writeFileSync(join(genDir, "backend-capabilities.json"), capabilitiesJson);
  manifest.push({ file: "backend-capabilities.json", sha256: sha(capabilitiesJson) });

  const versionDoc = [
    `CONTRACT_VERSION=${CONTRACT_VERSION}`,
    `BACKEND_REPOSITORY=${PROVENANCE.backendRepository}`,
    `BACKEND_COMMIT=${PROVENANCE.backendCommit}`,
    `MIGRATION_COUNT=${PROVENANCE.migrationCount}`,
    `FINAL_MIGRATION=${PROVENANCE.finalMigration}`,
    `GENERATED_AT=${PROVENANCE.generatedAt}`,
    ...manifest.map((m) => `SHA256_${m.file.replace(/[^A-Za-z0-9]/g, "_")}=${m.sha256}`),
    "",
  ].join("\n");
  writeFileSync(join(genDir, "CONTRACT_VERSION"), versionDoc);
  console.log(`wrote frontend snapshot → ${genDir} (${manifest.length} files + CONTRACT_VERSION)`);
}
