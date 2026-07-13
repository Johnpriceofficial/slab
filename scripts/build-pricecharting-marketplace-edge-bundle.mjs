import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [path.join(root, "src/server/pricecharting/marketplace-handler.ts")],
  outfile: path.join(root, "supabase/functions/_shared/pricecharting-marketplace-bundle.js"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "esnext",
  charset: "utf8",
  minify: true,
  legalComments: "none",
  banner: {
    js: "// AUTO-GENERATED — do not edit. Source: src/server/pricecharting/marketplace-handler.ts\n",
  },
});

console.log("✓ Bundled PriceCharting marketplace Edge handler");
