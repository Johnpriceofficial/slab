// Bundles the server-side PriceCharting handler (which imports the completed
// src/lib/pricecharting library) into a single Deno-importable ESM file for the
// Supabase Edge Function. The library uses Node/Vite-style extensionless
// imports; Deno requires extensions, so we inline everything into one file
// instead of modifying the library.
//
// Run:  node scripts/build-pricecharting-edge-bundle.mjs
// Output: supabase/functions/_shared/pricecharting-bundle.js
//
// Uses only web-standard globals (fetch, AbortController, setTimeout, Date,
// Math) so it runs unchanged under Deno.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [path.join(root, "src/server/pricecharting/handler.ts")],
  outfile: path.join(root, "supabase/functions/_shared/pricecharting-bundle.js"),
  bundle: true,
  format: "esm",
  platform: "neutral", // no Node or browser assumptions; web-standard globals only
  target: "esnext",
  charset: "utf8", // pin literal UTF-8 output so bundle bytes stay stable across esbuild versions
  minify: true, // keep the committed bundle small (large unminified bundles can exceed size limits
  // in some deployment/commit pipelines); functionally identical output either way.
  legalComments: "none",
  banner: {
    js:
      "// AUTO-GENERATED — do not edit. Source: src/server/pricecharting/handler.ts\n" +
      "// Regenerate with: node scripts/build-pricecharting-edge-bundle.mjs\n",
  },
});

console.log("✓ Bundled edge PriceCharting handler → supabase/functions/_shared/pricecharting-bundle.js");
