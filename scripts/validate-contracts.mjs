// scripts/validate-contracts.mjs
// Contract drift validation for the V2 backend contract bridge. Run with bun:
//   bun scripts/validate-contracts.mjs [--frontend <path-to-slab-scribe-pro>]
// Fails (exit 1) on any violation. Local-only: no network, no database.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const { OPERATIONS, CONTRACT_VERSION } = await import(
  join(ROOT, "contracts/backend-operations.ts")
);

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

// 1. Operation names unique.
const names = OPERATIONS.map((o) => o.name);
check(new Set(names).size === names.length, "operation names are not unique");

// 2. Every operation fully classified with a valid status.
const CLASSES = new Set(["BROWSER_CUSTOMER_SAFE","BROWSER_ADMIN_GATED","EDGE_FUNCTION_ONLY","SERVICE_ROLE_ONLY","DESTRUCTIVE_ADMIN_ONLY","INTERNAL_ONLY","SECURITY_REVIEW_REQUIRED"]);
const STATUSES = new Set(["READY","ADAPTER_REQUIRED","BACKEND_CONTRACT_REQUIRED","SECURITY_REVIEW_REQUIRED","DEFERRED"]);
for (const op of OPERATIONS) {
  check(CLASSES.has(op.classification), `${op.name}: invalid classification`);
  check(STATUSES.has(op.status), `${op.name}: invalid integration status`);
  // 3. Every READY operation has a concrete backend mapping.
  if (op.status === "READY") check(op.backendResource.length > 0, `${op.name}: READY without backendResource`);
  // 4. No destructive or service-only primitive in the browser surface.
  check(op.classification !== "DESTRUCTIVE_ADMIN_ONLY", `${op.name}: destructive operation exposed in frontend contract`);
  check(op.classification !== "SERVICE_ROLE_ONLY", `${op.name}: service-role operation exposed in frontend contract`);
  check(op.classification !== "EDGE_FUNCTION_ONLY" || op.backendResource.every((r) => r.startsWith("edge:")), `${op.name}: EDGE_FUNCTION_ONLY with non-edge resource`);
  // 5. Unknown resource kinds fail.
  for (const r of op.backendResource) {
    check(/^(table|rpc|edge|storage|auth|private):/.test(r), `${op.name}: unknown backend resource kind '${r}'`);
  }
  // 6. private-schema resources may not be READY (no client path exists by definition).
  if (op.backendResource.some((r) => r.startsWith("private:"))) {
    check(op.status !== "READY", `${op.name}: private-schema resource cannot be READY`);
  }
}

// 7. Forbidden primitives must not appear as operations at all.
const FORBIDDEN = ["purge", "hardDelete", "deleteStorage", "consumeCleanupQueue", "getCredential", "rawSql", "executeRpc"];
for (const n of names) {
  check(!FORBIDDEN.some((f) => n.toLowerCase().includes(f.toLowerCase())), `forbidden primitive operation name: ${n}`);
}

// 8. Contract version explicit and well-formed.
check(/^\d+\.\d+\.\d+-[0-9a-f]{8}-m\d+$/.test(CONTRACT_VERSION), `CONTRACT_VERSION malformed: ${CONTRACT_VERSION}`);

// 9. backend-capabilities.json is in sync with the manifest (regenerate-and-compare).
const capPath = join(ROOT, "contracts/backend-capabilities.json");
check(existsSync(capPath), "contracts/backend-capabilities.json missing — run build-contract-snapshot");
if (existsSync(capPath)) {
  const cap = JSON.parse(readFileSync(capPath, "utf8"));
  check(cap.provenance?.contractVersion === CONTRACT_VERSION, "capabilities provenance version drift");
  check(cap.operations?.length === OPERATIONS.length, "capabilities operation count drift");
  const capNames = new Set((cap.operations ?? []).map((o) => o.operation));
  for (const n of names) check(capNames.has(n), `capabilities missing operation ${n}`);
}

// 10. Frontend snapshot hash match (when --frontend given).
const feArg = process.argv.indexOf("--frontend");
if (feArg !== -1) {
  const feRoot = process.argv[feArg + 1];
  const genDir = join(feRoot, "src/integrations/backend/generated");
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");
  const pairs = [
    ["contracts/database.types.ts", "database.types.ts"],
    ["contracts/backend-operations.ts", "backend-operations.ts"],
    ["contracts/error-codes.ts", "error-codes.ts"],
    ["contracts/backend-capabilities.json", "backend-capabilities.json"],
  ];
  for (const [src, dst] of pairs) {
    const s = join(ROOT, src), d = join(genDir, dst);
    check(existsSync(d), `frontend snapshot missing ${dst}`);
    if (existsSync(d)) check(sha(readFileSync(s)) === sha(readFileSync(d)), `frontend snapshot drift: ${dst}`);
  }
  const vPath = join(genDir, "CONTRACT_VERSION");
  check(existsSync(vPath), "frontend snapshot missing CONTRACT_VERSION");
  if (existsSync(vPath)) {
    const v = readFileSync(vPath, "utf8");
    check(v.includes(`CONTRACT_VERSION=${CONTRACT_VERSION}`), "frontend CONTRACT_VERSION drift");
    check(v.includes("BACKEND_COMMIT=ba3953fdb68c31435c7dac732f67d8d53aa2adcb"), "frontend snapshot backend-commit drift");
  }
}

if (failures.length) {
  console.error(`CONTRACT VALIDATION FAILED (${failures.length}):`);
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}
console.log(`contract validation OK — ${OPERATIONS.length} operations, version ${CONTRACT_VERSION}`);
