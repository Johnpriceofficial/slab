/**
 * Requirement 9: the OpenAI key is server-only.
 *
 * The browser bundle must never reference the provider secret. Client image
 * analysis goes exclusively through the Supabase Edge Function, which injects
 * the key from its own environment. These checks read the actual source tree so
 * a regression that leaks the key into client code fails the build.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const CLIENT_SRC = join(ROOT, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("OpenAI key stays server-side", () => {
  const clientFiles = walk(CLIENT_SRC).filter((f) => !f.includes(`${join("src", "test")}`));

  it("no client-side source references the OpenAI API key or a raw key literal", () => {
    const offenders: string[] = [];
    for (const file of clientFiles) {
      const text = readFileSync(file, "utf8");
      if (/OPENAI_API_KEY/.test(text) || /\bsk-[A-Za-z0-9_-]{10,}/.test(text)) {
        offenders.push(file.replace(ROOT + "/", ""));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("client analysis calls the Edge Function, not the provider directly", () => {
    const data = readFileSync(join(CLIENT_SRC, "lib", "slabs", "data.ts"), "utf8");
    expect(data).toMatch(/functions\.invoke\(\s*["']analyze-slab["']/);
    expect(data).not.toMatch(/api\.openai\.com/);
  });

  it("the Edge Function reads the key from the server environment only", () => {
    const edge = readFileSync(join(ROOT, "supabase", "functions", "analyze-slab", "index.ts"), "utf8");
    expect(edge).toMatch(/Deno\.env\.get\(\s*["']OPENAI_API_KEY["']\s*\)/);
    // store:false is required so prompts/images are not retained provider-side.
    expect(edge).toMatch(/store:\s*false/);
  });
});
