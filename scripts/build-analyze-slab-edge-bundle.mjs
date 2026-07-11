// Bundles the server-side analyze-slab handler into a single Deno-importable ESM
// file for the Supabase Edge Function `analyze-slab`. Same approach as the
// PriceCharting bundle: the handler is pure and uses only web-standard globals,
// so it runs unchanged under Deno.
//
// Run:  node scripts/build-analyze-slab-edge-bundle.mjs
// Output: supabase/functions/_shared/analyze-slab-bundle.js

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [path.join(root, "src/server/analyze-slab/handler.ts")],
  outfile: path.join(root, "supabase/functions/_shared/analyze-slab-bundle.js"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "esnext",
  legalComments: "none",
  banner: {
    js:
      "// AUTO-GENERATED — do not edit. Source: src/server/analyze-slab/handler.ts\n" +
      "// Regenerate with: node scripts/build-analyze-slab-edge-bundle.mjs\n",
  },
});

console.log("✓ Bundled edge analyze-slab handler → supabase/functions/_shared/analyze-slab-bundle.js");
