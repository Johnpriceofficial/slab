#!/usr/bin/env bun
/**
 * Admin batch driver for the GradedCardValue valuation backfill (Node/Bun glue
 * only — no matching or pricing logic lives here).
 *
 * Each candidate slab goes through EXACTLY the flow behind SlabDetail's
 * "Refresh pricing" button: refreshSlabPricing() from src/lib/slabs/data.ts,
 * i.e. pricecharting-search (action "search" → action "value") followed by the
 * atomic, stale-guarded apply_slab_pricing RPC. Because the library functions
 * are REUSED (they run fine under bun — the supabase-js singleton is built from
 * env), all data-safety rules hold by construction:
 *   - an unlinked slab is linked ONLY on an auto-confirmed exact search match;
 *     anything ambiguous is reported as a conflict for manual intake review;
 *   - a manual-provenance guide value is NEVER overwritten
 *     (buildRefreshScalars sets apply_value=false);
 *   - the operator's Final / Quick-Sale / Replacement values are structurally
 *     untouchable (the refresh scalars carry no such fields);
 *   - writes are atomic and stale-guarded server-side (apply_slab_pricing).
 *
 * SAFE BY DEFAULT: without --execute this is a DRY RUN — it authenticates,
 * verifies admin access (a zero-cost preflight that cannot reach
 * PriceCharting), reads the inventory, prints the plan, and writes the report.
 * It performs NO search/value calls and NO writes.
 *
 * Rate limits: the server enforces a durable, fail-closed 1 req/s
 * PriceCharting budget (reserve_api_request_slot); this driver additionally
 * runs strictly sequentially and sleeps ~1.1 s per upstream API call, so the
 * server queue never backs up. Expect roughly 1.2 s per API call — a full
 * first backfill of ~1,000 API calls is ~20–25 minutes.
 *
 * Usage:
 *   SUPABASE_URL="https://<project-ref>.supabase.co" \
 *   SUPABASE_ANON_KEY="<anon key>" \
 *   SUPABASE_ADMIN_JWT="<signed-in ADMIN user's access token>" \
 *     bun scripts/backfill-valuations.ts [flags]         # dry-run (default)
 *     bun scripts/backfill-valuations.ts --execute ...   # real run
 *
 * Flags:
 *   --execute              actually refresh (default is a read-only dry run)
 *   --dry-run              explicit dry run (default; conflicts with --execute)
 *   --limit N              max slabs to process this run (default 25)
 *   --only-unlinked        only slabs with no PriceCharting product link
 *   --only-needs-review    only slabs whose valuation_status = 'needs_review'
 *   --slab <id>            one slab (UUID, inventory code "S0012", or number);
 *                          bypasses the freshness skip for a targeted test
 *   --max-age-days D       skip linked slabs priced within D days (default 7)
 *   --report <path>        write a machine-readable JSON report here
 *   --help                 this text
 *
 * SUPABASE_ADMIN_JWT is a logged-in ADMIN user's Supabase access token — the
 * edge function verifies the JWT and requires is_admin; apply_slab_pricing is
 * can_access_slab-gated. Obtain it from an authenticated admin browser session
 * (never email/password — this script does not accept credentials):
 *   1. Sign in to the GradedCardValue admin app as the admin user.
 *   2. DevTools → Application → Local Storage → the app origin → key
 *      "sb-<project-ref>-auth-token" → copy the "access_token" field of the
 *      stored JSON.
 *   Tokens expire (default 1 h). The driver refuses a token that would expire
 *   mid-run and stops immediately on any 401/403.
 *
 * Exit codes: 0 done · 1 done with per-slab errors · 2 fatal (config/auth) ·
 * 130 interrupted (partial report still written).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  classifyRefreshOutcome,
  decodeJwtExpiry,
  estimateRunSeconds,
  isAuthFailureMessage,
  selectBackfillCandidates,
  type BackfillOutcome,
  type BackfillSelectionOptions,
} from "../src/lib/slabs/backfill-selection.ts";
import { isManualProvenance } from "../src/lib/slabs/valuation-provenance.ts";
import { parseInventoryQuery } from "../src/lib/slabs/inventory-code.ts";
import { formatCents } from "../src/lib/slabs/format.ts";
import type { Slab } from "../src/lib/slabs/types.ts";

/* ------------------------------- CLI glue -------------------------------- */

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
function die(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(2);
}

const USAGE = `Admin batch driver for the valuation backfill — DRY RUN unless --execute.

  SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_ADMIN_JWT=… \\
    bun scripts/backfill-valuations.ts [--execute] [--limit N] [--only-unlinked]
        [--only-needs-review] [--slab <uuid|S0012|12>] [--max-age-days D]
        [--report <path>]

SUPABASE_ADMIN_JWT is a signed-in ADMIN user's access token (DevTools →
Application → Local Storage → "sb-<project-ref>-auth-token" → access_token).
Never an email/password. See the header of this file for full documentation.`;

if (flag("help")) {
  console.log(USAGE);
  process.exit(0);
}

const execute = flag("execute");
if (execute && flag("dry-run")) die("--execute and --dry-run contradict each other; pass exactly one.");
const dryRun = !execute;

const limit = Number(arg("limit", "25"));
if (!Number.isInteger(limit) || limit < 1) die("--limit must be a positive integer.");
const maxAgeDays = Number(arg("max-age-days", "7"));
if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) die("--max-age-days must be a non-negative number.");
const onlyUnlinked = flag("only-unlinked");
const onlyNeedsReview = flag("only-needs-review");
const singleSlab = arg("slab");
const reportPath = arg("report");

/* ------------------------------ environment ------------------------------ */

const SUPABASE_URL = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? "";
const ADMIN_JWT = process.env.SUPABASE_ADMIN_JWT ?? "";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  die("SUPABASE_URL and SUPABASE_ANON_KEY are required (VITE_-prefixed variants are accepted).");
}
if (!ADMIN_JWT) {
  die(
    "SUPABASE_ADMIN_JWT is required: a signed-in ADMIN user's access token.\n" +
      "  Get it from an authenticated admin browser session — DevTools → Application →\n" +
      '  Local Storage → "sb-<project-ref>-auth-token" → the "access_token" field.\n' +
      "  This script never accepts an email/password.",
  );
}

// The shared browser client is constructed from import.meta.env at import
// time; under bun import.meta.env IS process.env, so set the VITE_ names
// BEFORE dynamically importing the library modules.
process.env.VITE_SUPABASE_URL = SUPABASE_URL;
process.env.VITE_SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;

const { supabase } = await import("../src/integrations/supabase/client.ts");
const { refreshSlabPricing } = await import("../src/lib/slabs/data.ts");

/* ------------------------------ authenticate ------------------------------ */

// No refresh token exists for a pasted access token: stop the auto-refresh
// ticker so nothing ever tries to "refresh" with the placeholder below. The
// pre-run expiry check guarantees the token outlives the run instead.
await supabase.auth.stopAutoRefresh();
const session = await supabase.auth.setSession({
  access_token: ADMIN_JWT,
  refresh_token: "backfill-driver-has-no-refresh-token",
});
if (session.error || !session.data.session) {
  die(
    `Authentication failed: ${session.error?.message ?? "no session"}.\n` +
      "  SUPABASE_ADMIN_JWT must be a CURRENT admin access token (they expire, default 1 h).",
  );
}
const authUser = session.data.session.user;
console.log(`Authenticated as ${authUser.email ?? authUser.id}`);

// Zero-cost admin preflight: an empty search body passes the JWT + is_admin
// gate in supabase/functions/pricecharting-search/index.ts, then fails input
// validation (400 MISSING_PARAMETER in handleSearch) BEFORE any rate-limit
// reservation or PriceCharting call. 401/403 here means the run must not start.
{
  const res = await fetch(`${SUPABASE_URL}/functions/v1/pricecharting-search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${ADMIN_JWT}` },
    body: JSON.stringify({}),
  });
  if (res.status === 401) die("Auth preflight: the token was rejected (401). Mint a fresh admin access token.");
  if (res.status === 403) die("Auth preflight: this user is not an admin (403). Use an admin account's token.");
  if (res.status !== 400) {
    const body = await res.text().catch(() => "");
    die(`Auth preflight expected 400 MISSING_PARAMETER but got HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  console.log("Admin access verified (preflight consumed no PriceCharting quota).");
}

/* ------------------------------- read slabs ------------------------------- */

function dieOnAuthStatus(status: number | undefined, message: string): void {
  if (status === 401 || status === 403 || isAuthFailureMessage(message)) {
    die(`Authorization failed while reading slabs (HTTP ${status ?? "?"}): ${message}`);
  }
}

// The generated Database types predate the slabs table; use the same
// loosely-typed handle the data layer itself uses.
const sb = supabase as unknown as { from: (table: string) => any };

async function fetchAllSlabs(): Promise<Slab[]> {
  const PAGE = 1000;
  const rows: Slab[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error, status } = await sb
      .from("slabs")
      .select("*")
      .is("archived_at", null)
      .order("inventory_number", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      dieOnAuthStatus(status, error.message);
      die(`Failed to read slabs: ${error.message}`);
    }
    rows.push(...((data ?? []) as Slab[]));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function fetchOneSlab(idOrCode: string): Promise<Slab> {
  let q = sb.from("slabs").select("*").is("archived_at", null);
  const trimmed = idOrCode.trim();
  const inv = parseInventoryQuery(trimmed);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    q = q.eq("id", trimmed);
  } else if (inv && inv.prefix) {
    q = q.eq("inventory_prefix", inv.prefix).eq("inventory_sequence", inv.sequence);
  } else if (inv) {
    q = q.eq("inventory_number", inv.sequence);
  } else {
    die(`--slab "${idOrCode}" is not a UUID, an inventory code (S0012), or an inventory number.`);
  }
  const { data, error, status } = await q.limit(2);
  if (error) {
    dieOnAuthStatus(status, error.message);
    die(`Failed to read slab "${idOrCode}": ${error.message}`);
  }
  if (!data || data.length === 0) die(`Slab "${idOrCode}" was not found (or is archived).`);
  if (data.length > 1) die(`Slab "${idOrCode}" is ambiguous — pass the UUID.`);
  return data[0] as Slab;
}

/* --------------------------------- select --------------------------------- */

const startedAt = Date.now();
const selectionOpts: BackfillSelectionOptions = {
  onlyUnlinked,
  onlyNeedsReview,
  maxAgeDays,
  limit,
  nowIso: new Date().toISOString(),
};

interface ResultRow {
  slab_id: string;
  inventory_code: string | null;
  inventory_number: number;
  outcome: BackfillOutcome | "planned";
  reason: string | null;
  message: string | null;
  guide_cents: number | null;
  product_name: string | null;
  api_calls: number;
}

let inventoryCount: number;
let candidates: Array<{ slab: Slab; api_calls: 1 | 2 }>;
let skipped: Array<{ slab: Slab; reason: string }> = [];
let deferred = 0;
let totalApiCalls: number;

if (singleSlab) {
  const slab = await fetchOneSlab(singleSlab);
  inventoryCount = 1;
  // Explicit single-slab test: freshness is bypassed on purpose (the operator
  // asked for THIS slab); auto-confirm-only linking still applies unchanged.
  candidates = [{ slab, api_calls: slab.pricecharting_product_id ? 1 : 2 }];
  totalApiCalls = candidates[0].api_calls;
} else {
  const all = await fetchAllSlabs();
  inventoryCount = all.length;
  const sel = selectBackfillCandidates(all, selectionOpts);
  candidates = sel.candidates;
  skipped = sel.skipped;
  deferred = sel.deferred;
  totalApiCalls = sel.total_api_calls;
}

const label = (s: Slab) => `${s.inventory_code ?? `#${s.inventory_number}`}`.padEnd(7);

console.log(
  `\n${dryRun ? "DRY RUN" : "EXECUTE"} — inventory ${inventoryCount}, candidates ${candidates.length}` +
    (deferred ? ` (+${deferred} beyond --limit ${limit}, next run)` : "") +
    `, skipped ${skipped.length}, est. ${totalApiCalls} API calls ≈ ${estimateRunSeconds(totalApiCalls)}s`,
);

for (const { slab, reason } of skipped) {
  console.log(`  ${label(slab)} skipped(${reason})`);
}

/* ------------------------------ token budget ------------------------------ */

if (execute) {
  const exp = decodeJwtExpiry(ADMIN_JWT);
  const neededSeconds = estimateRunSeconds(totalApiCalls) + 120;
  if (exp === null) {
    console.warn("Warning: could not read the token's exp claim; it may expire mid-run.");
  } else {
    const remaining = Math.floor(exp - Date.now() / 1000);
    if (remaining < neededSeconds) {
      die(
        `The admin token expires in ~${Math.max(remaining, 0)}s but this run needs ~${neededSeconds}s.\n` +
          "  Mint a fresh access token (sign the admin session in again) and retry —\n" +
          "  already-refreshed slabs are skipped, so the run resumes where it stopped.",
      );
    }
  }
}

/* --------------------------------- run ----------------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PACING_MS_PER_CALL = 1100; // client-side politeness atop the server's durable 1 req/s gate

let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  console.error("\nSIGINT — finishing the current slab, then writing the report…");
});

const results: ResultRow[] = [];
let fatalAuthError: string | null = null;

if (dryRun) {
  for (const { slab, api_calls } of candidates) {
    const linked = Boolean(slab.pricecharting_product_id);
    console.log(
      `  ${label(slab)} would ${linked ? `re-value product ${slab.pricecharting_product_id}` : "search + value (links only on an auto-confirmed exact match)"}` +
        ` — ${api_calls} API call${api_calls > 1 ? "s" : ""}` +
        (slab.valuation_provenance && isManualProvenance(slab.valuation_provenance)
          ? " [manual guide will be preserved]"
          : ""),
    );
    results.push({
      slab_id: slab.id,
      inventory_code: slab.inventory_code ?? null,
      inventory_number: slab.inventory_number,
      outcome: "planned",
      reason: slab.pricecharting_product_id ? "value_only" : "search_then_value",
      message: null,
      guide_cents: null,
      product_name: slab.pricecharting_product_name ?? null,
      api_calls,
    });
  }
  console.log("\nDry run only — nothing was refreshed. Re-run with --execute to apply.");
} else {
  let position = 0;
  let previousCalls = 0;
  for (const { slab, api_calls } of candidates) {
    if (interrupted) break;
    position += 1;
    if (previousCalls > 0) await sleep(PACING_MS_PER_CALL * previousCalls);

    const wasLinked = Boolean(slab.pricecharting_product_id);
    const manual = Boolean(slab.valuation_provenance && isManualProvenance(slab.valuation_provenance));
    const res = await refreshSlabPricing(slab);
    const { outcome, reason } = classifyRefreshOutcome(res.status, wasLinked);

    const detail =
      res.status === "applied"
        ? `guide ${formatCents(res.guide_cents ?? null)}${manual ? " [manual guide preserved]" : ""} "${res.product_name ?? ""}"`
        : (res.message ?? "");
    console.log(
      `  [${String(position).padStart(3)}/${candidates.length}] ${label(slab)} ${outcome}${reason ? `(${reason})` : ""}  ${detail}`,
    );

    results.push({
      slab_id: slab.id,
      inventory_code: slab.inventory_code ?? null,
      inventory_number: slab.inventory_number,
      outcome,
      reason,
      message: res.message ?? null,
      guide_cents: res.status === "applied" ? (res.guide_cents ?? null) : null,
      product_name: res.product_name ?? slab.pricecharting_product_name ?? null,
      api_calls,
    });
    previousCalls = api_calls;

    if (outcome === "error" && isAuthFailureMessage(res.message)) {
      fatalAuthError = res.message ?? "authorization failure";
      console.error(`\n✗ Stopping: authorization failure — ${fatalAuthError}`);
      console.error("  Mint a fresh admin token and re-run; refreshed slabs will be skipped.");
      break;
    }
  }
}

/* ------------------------------ summary/report ---------------------------- */

const counts = new Map<string, number>();
for (const r of results) {
  const key = r.reason ? `${r.outcome}(${r.reason})` : r.outcome;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
for (const { reason } of skipped) {
  counts.set(`skipped(${reason})`, (counts.get(`skipped(${reason})`) ?? 0) + 1);
}

const durationS = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n── Summary ──────────────────────────────`);
console.log(`  mode                 ${dryRun ? "dry-run" : "execute"}`);
console.log(`  inventory rows       ${inventoryCount}`);
console.log(`  processed            ${results.length}${deferred ? `   (deferred beyond --limit: ${deferred})` : ""}`);
for (const [key, n] of [...counts.entries()].sort()) {
  console.log(`  ${key.padEnd(20)} ${n}`);
}
console.log(`  duration             ${durationS}s`);

if (reportPath) {
  const out = resolve(reportPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        mode: dryRun ? "dry-run" : "execute",
        interrupted,
        fatal_auth_error: fatalAuthError,
        auth_user: authUser.id,
        params: {
          limit,
          max_age_days: maxAgeDays,
          only_unlinked: onlyUnlinked,
          only_needs_review: onlyNeedsReview,
          slab: singleSlab ?? null,
        },
        totals: {
          inventory: inventoryCount,
          candidates: candidates.length,
          deferred,
          estimated_api_calls: totalApiCalls,
          by_outcome: Object.fromEntries(counts),
        },
        results,
        skipped_selection: skipped.map(({ slab, reason }) => ({
          slab_id: slab.id,
          inventory_code: slab.inventory_code ?? null,
          inventory_number: slab.inventory_number,
          reason,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`  report               ${out}`);
}

if (fatalAuthError) process.exit(2);
if (interrupted) process.exit(130);
process.exit(results.some((r) => r.outcome === "error") ? 1 : 0);
