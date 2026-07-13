// Supabase Edge Function: analyze-slab
//
// The ONLY place ANTHROPIC_API_KEY is read. The browser sends slab image bytes;
// this function calls the vision model and returns PROPOSED identity fields with
// confidence. It NEVER saves anything and NEVER returns the API key. Admin-only.
//
// Regenerate the bundle after changing the handler:
//   node scripts/build-analyze-slab-edge-bundle.mjs

import { corsHeaders } from "../_shared/cors.ts";
import { isCallerAdmin, unauthorizedResponse } from "../_shared/auth.ts";
import { consumeDailyQuota } from "../_shared/quota.ts";
// deno-lint-ignore no-explicit-any
import { analyzeSlabImages } from "../_shared/analyze-slab-bundle.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = Deno.env.get("ANALYZE_MODEL") ?? "claude-sonnet-5";
// Daily ceiling on paid vision calls (override with ANALYZE_DAILY_LIMIT).
const DAILY_LIMIT = Number(Deno.env.get("ANALYZE_DAILY_LIMIT") ?? "200");

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Build a callModel(...) that talks to Anthropic. The key stays in this closure
 * and is never returned or logged. Returns the model's raw text reply.
 */
function makeAnthropicCaller(apiKey: string) {
  // deno-lint-ignore no-explicit-any
  return async (req: any): Promise<string> => {
    const content: unknown[] = [{ type: "text", text: req.instruction }];
    for (const img of req.images) {
      content.push({ type: "text", text: `Image: ${img.label}` });
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.image.mime, data: img.image.base64 },
      });
    }
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: req.system,
        messages: [{ role: "user", content }],
      }),
    });
    if (!res.ok) {
      // Do NOT leak provider internals (which could echo the key in some errors).
      throw new Error(`Analysis provider returned HTTP ${res.status}.`);
    }
    const data = await res.json();
    const parts = Array.isArray(data?.content) ? data.content : [];
    const text = parts.filter((p: { type?: string }) => p?.type === "text").map((p: { text?: string }) => p.text ?? "").join("\n");
    return text || "{}";
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ status: "error", error_code: "INVALID_PARAMETER", message: "POST required" }, 405);

  // Admin-only.
  const { user, isAdmin } = await isCallerAdmin(req);
  if (!user) return unauthorizedResponse(corsHeaders);
  if (!isAdmin) return json({ status: "error", error_code: "NOT_AUTHORIZED", message: "Admin access required" }, 403);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json({ status: "error", error_code: "NOT_CONFIGURED", message: "Image analysis is not configured." }, 502);
  }

  // Durable daily cost ceiling — refuse (429) once the day's budget is spent,
  // before making any paid model call.
  if (!(await consumeDailyQuota("analyze-slab", DAILY_LIMIT))) {
    return json(
      { status: "error", error_code: "QUOTA_EXCEEDED", message: "Daily image-analysis limit reached. Try again tomorrow." },
      429,
    );
  }

  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return json({ status: "error", error_code: "INVALID_PARAMETER", message: "Invalid JSON body." }, 400);
  }

  try {
    const result = await analyzeSlabImages(input, { callModel: makeAnthropicCaller(apiKey) });
    return json(result.body, result.statusCode);
  } catch (_err) {
    return json({ status: "error", error_code: "UNKNOWN_ERROR", message: "Unexpected error." }, 500);
  }
});
