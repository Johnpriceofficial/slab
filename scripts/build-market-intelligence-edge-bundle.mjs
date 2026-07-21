// Bundles the market-intelligence orchestrator (and the pure identity/market/
// adapter logic it re-exports) into a single Deno-importable ESM file for the
// Supabase Edge Function `market-intelligence`. The `@/` alias is resolved to
// src/ so the internal imports inline correctly.
//
// Run:  node scripts/build-market-intelligence-edge-bundle.mjs
// Output: supabase/functions/_shared/market-intelligence-bundle.js

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [path.join(root, "src/server/market-intelligence/engine.ts")],
  outfile: path.join(root, "supabase/functions/_shared/market-intelligence-bundle.js"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "esnext",
  charset: "utf8",
  legalComments: "none",
  alias: { "@": path.join(root, "src") },
  banner: {
    js:
      "// AUTO-GENERATED — do not edit. Source: src/server/market-intelligence/engine.ts\n" +
      "// Regenerate with: node scripts/build-market-intelligence-edge-bundle.mjs\n",
  },
});

console.log("✓ Bundled market-intelligence engine → supabase/functions/_shared/market-intelligence-bundle.js");
