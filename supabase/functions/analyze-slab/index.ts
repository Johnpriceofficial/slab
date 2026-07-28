// GradedCardValue.com — OpenAI vision analysis (admins + active confirmed customers).
// Uses Responses API + native strict Structured Outputs. Original images and
// deterministic variants are evidence; no image generation/editing is used.
//
// Customer access model: the caller's identity comes only from the verified
// JWT (never a request-body user id); customers must be email-confirmed with
// an active customer_profiles row; per-user quota fails closed; every image
// is validated server-side before any provider request; and the analysis run
// plus its field evidence are stamped with the caller as owner.

import { createClient } from "npm:@supabase/supabase-js@2.110.2";
import { corsHeaders } from "../_shared/cors.ts";
import { isCallerAdmin, unauthorizedResponse } from "../_shared/auth.ts";
import { consumeDailyQuota, consumeUserDailyQuota } from "../_shared/quota.ts";
import { decideAnalyzeAccess, isCustomerAnalysisEnabled } from "../_shared/analyze-access.ts";
// deno-lint-ignore no-explicit-any
import { analyzeSlabImages, runAnalyzeRequestPipeline } from "../_shared/analyze-slab-bundle.js";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = Deno.env.get("OPENAI_ANALYZE_MODEL") ?? "gpt-5.6-terra";
const DAILY_LIMIT = Number(Deno.env.get("ANALYZE_DAILY_LIMIT") ?? "200");
/** Hard per-user daily cap; the profile allowance is enforced inside the RPC. */
const USER_DAILY_LIMIT = Number(Deno.env.get("ANALYZE_USER_DAILY_LIMIT") ?? "25");
const SCHEMA_VERSION = "gcv-vision-2.0";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const evidenceField = {
  type: "object",
  additionalProperties: false,
  required: ["value", "normalized_value", "confidence", "source", "source_image_id", "crop_id", "bounding_box", "readability", "readable", "alternatives", "reason"],
  properties: {
    value: { type: ["string", "null"] },
    normalized_value: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    source: { type: "string", enum: ["front", "back", "label", "card", "unknown"] },
    source_image_id: { type: ["string", "null"] },
    crop_id: { type: ["string", "null"] },
    bounding_box: {
      anyOf: [
        { type: "null" },
        { type: "array", items: { type: "number", minimum: 0, maximum: 1 }, minItems: 4, maxItems: 4 },
      ],
    },
    readability: { type: "string", enum: ["clear", "partial", "unreadable"] },
    readable: { type: "boolean" },
    alternatives: { type: "array", items: { type: "string" }, maxItems: 5 },
    reason: { type: "string" },
  },
} as const;

const FIELD_KEYS = [
  "card_name", "set", "set_code", "card_number", "collector_number_raw",
  "collector_number_numerator", "collector_number_denominator", "year", "language",
  "rarity", "finish", "variation", "error_designation", "grader", "grade", "grade_label",
  "certification_number", "label_description", "front_or_back",
] as const;

const mainSchema = {
  type: "object",
  additionalProperties: false,
  required: ["fields", "label_matches_card", "overall_confidence", "warnings", "identity_conflicts", "required_user_actions", "search_queries"],
  properties: {
    fields: {
      type: "object",
      additionalProperties: false,
      required: FIELD_KEYS,
      properties: Object.fromEntries(FIELD_KEYS.map((key) => [key, evidenceField])),
    },
    label_matches_card: { type: ["boolean", "null"] },
    overall_confidence: { type: "number", minimum: 0, maximum: 1 },
    warnings: { type: "array", items: { type: "string" } },
    identity_conflicts: { type: "array", items: { type: "string" } },
    required_user_actions: { type: "array", items: { type: "string" } },
    search_queries: { type: "array", items: { type: "string" }, maxItems: 8 },
  },
} as const;

function singleFieldSchema(field: "card_number" | "certification_number") {
  return {
    type: "object",
    additionalProperties: false,
    required: [field],
    properties: {
      [field]: {
        type: "object",
        additionalProperties: false,
        required: ["value", "confidence", "readable", "alternatives", "characters"],
        properties: {
          value: { type: ["string", "null"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          readable: { type: "boolean" },
          alternatives: { type: "array", items: { type: "string" }, maxItems: 5 },
          characters: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["position", "value", "confidence", "alternatives"],
              properties: {
                position: { type: "integer", minimum: 0 },
                value: { type: ["string", "null"] },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                alternatives: { type: "array", items: { type: "string" }, maxItems: 4 },
              },
            },
          },
        },
      },
    },
  };
}

const conciseEvidence = {
  type: "object",
  additionalProperties: false,
  required: ["value", "confidence", "readable", "alternatives"],
  properties: {
    value: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    readable: { type: "boolean" },
    alternatives: { type: "array", items: { type: "string" }, maxItems: 5 },
  },
} as const;

const criticalIdentitySchema = {
  type: "object",
  additionalProperties: false,
  required: ["fields", "artwork"],
  properties: {
    fields: {
      type: "object",
      additionalProperties: false,
      required: ["card_name", "grader", "grade", "language", "variation"],
      properties: Object.fromEntries(["card_name", "grader", "grade", "language", "variation"].map((key) => [key, conciseEvidence])),
    },
    artwork: {
      type: "object",
      additionalProperties: false,
      required: ["character", "artwork_composition", "card_border", "set_symbol", "language", "collector_number", "rarity_marking", "promo_marking", "error_or_variation_markings"],
      properties: Object.fromEntries(["character", "artwork_composition", "card_border", "set_symbol", "language", "collector_number", "rarity_marking", "promo_marking", "error_or_variation_markings"].map((key) => [key, conciseEvidence])),
    },
  },
} as const;

function extractOutputText(data: Record<string, unknown>): string {
  if (typeof data.output_text === "string") return data.output_text;
  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output as Array<Record<string, unknown>>) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  throw new Error("OpenAI returned no structured output.");
}

async function openAIRequest(apiKey: string, req: any, telemetry: Array<Record<string, unknown>>): Promise<string> {
  const isCard = /Look ONLY at the card_number/i.test(req.instruction);
  const isCert = /Look ONLY at the certification_number/i.test(req.instruction);
  const isCritical = /Independently reread the critical identity fields/i.test(req.instruction);
  const schema = isCard ? singleFieldSchema("card_number") : isCert ? singleFieldSchema("certification_number") : isCritical ? criticalIdentitySchema : mainSchema;
  const name = isCard ? "collector_number_reread" : isCert ? "certification_number_reread" : isCritical ? "critical_identity_and_artwork" : "slab_identity";
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: `${req.system}\n\n${req.instruction}` }];
  for (const img of req.images) {
    content.push({ type: "input_text", text: `Evidence image: ${img.label}. Original or deterministic derivative; never reconstruct missing characters.` });
    content.push({ type: "input_image", image_url: `data:${img.image.mime};base64,${img.image.base64}`, detail: "original" });
  }

  const started = Date.now();
  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        store: false,
        input: [{ role: "user", content }],
        text: { format: { type: "json_schema", name, strict: true, schema } },
      }),
    });
    lastStatus = res.status;
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      const outputText = extractOutputText(data);
      telemetry.push({ request_id: data.id ?? null, model: data.model ?? MODEL, usage: data.usage ?? null, latency_ms: Date.now() - started, analysis_type: name, structured_output: JSON.parse(outputText) });
      return outputText;
    }
    if (res.status !== 429 && res.status < 500) break;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 500 * 2 ** attempt + Math.floor(Math.random() * 250))));
  }
  throw new Error(`OpenAI analysis failed with HTTP ${lastStatus}.`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ status: "error", error_code: "INVALID_PARAMETER", message: "POST required" }, 405);
  const { user, isAdmin } = await isCallerAdmin(req);
  if (!user) return unauthorizedResponse(corsHeaders);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Rollout flag: fail-closed — only the exact string "true" enables
  // non-admin traffic. Admin access is never affected.
  const customerAccessEnabled = isCustomerAnalysisEnabled(Deno.env.get("ANALYZE_SLAB_CUSTOMER_ENABLED"));

  // Customer authorization facts. The profile is read with the service role,
  // keyed strictly by the verified JWT user id — a lookup failure fails
  // closed. While the rollout flag is disabled, non-admin callers are refused
  // before any profile lookup happens.
  let profile: { ok: true; accountStatus: string | null } | { ok: false } = { ok: true, accountStatus: null };
  if (!isAdmin && customerAccessEnabled) {
    const { data, error } = await admin.from("customer_profiles")
      .select("account_status")
      .eq("id", user.id)
      .maybeSingle();
    profile = error ? { ok: false } : { ok: true, accountStatus: data?.account_status ?? null };
  }
  const access = decideAnalyzeAccess({
    user: { id: user.id, emailConfirmed: Boolean(user.email_confirmed_at) },
    isAdmin,
    customerAccessEnabled,
    profile,
  });
  if (!access.allowed) {
    return json({ status: "error", error_code: access.errorCode, message: access.message }, access.statusCode);
  }

  // Steps 4–8 run through the pure, unit-tested pipeline so the strict order
  // (parse → validate → quota → provider-config → provider) is guaranteed:
  // a malformed body/image returns its typed 400/413 even when the provider
  // key is absent, rejected payloads never consume quota or call the provider,
  // and NOT_CONFIGURED is only reachable after authorization, validation and
  // quota all pass.
  const result = await runAnalyzeRequestPipeline({
    role: access.role,
    parseJson: async () => {
      try { return { ok: true, value: await req.json() }; } catch { return { ok: false }; }
    },
    consumeQuota: (role: "admin" | "customer") =>
      role === "admin"
        ? consumeDailyQuota("analyze-slab-openai", DAILY_LIMIT)
        : consumeUserDailyQuota(user.id, "analyze-slab-openai", USER_DAILY_LIMIT),
    getApiKey: () => Deno.env.get("OPENAI_API_KEY"),
    runAnalysis: (input: unknown, apiKey: string) => runAnalysis(admin, user.id, input, apiKey),
  });
  return json(result.body, result.statusCode);
});

// Step 8: the provider request + persistence, invoked only for a fully
// authorized, parsed, validated and quota'd request.
async function runAnalysis(
  // deno-lint-ignore no-explicit-any
  admin: any,
  ownerId: string,
  input: unknown,
  apiKey: string,
): Promise<{ statusCode: number; body: unknown }> {
  const telemetry: Array<Record<string, unknown>> = [];
  try {
    const result = await analyzeSlabImages({ ...(input as Record<string, unknown>), strict_multi_pass: true }, { callModel: (modelReq: unknown) => openAIRequest(apiKey, modelReq, telemetry) });
    // `status` is a plain string in the handler's return type, so checking it does
    // not narrow the success/error union — and every read of `warnings` below then
    // fails `deno check`. Discriminate on the field we actually consume.
    const body = result.body;
    if (body.status !== "success" || !("warnings" in body)) return { statusCode: result.statusCode, body };

    const totalLatency = telemetry.reduce((sum, row) => sum + Number(row.latency_ms ?? 0), 0);
    const { data: run } = await admin.from("ai_analysis_runs").insert({
      // Runs are never ownerless: the verified caller owns what they created.
      owner_id: ownerId,
      provider: "OPENAI",
      model: String(telemetry[0]?.model ?? MODEL),
      schema_version: SCHEMA_VERSION,
      analysis_type: "multi_pass_slab_identity",
      status: /disagree|could not read/i.test(body.warnings.join(" ")) ? "needs_review" : "succeeded",
      request_id: telemetry.map((row) => row.request_id).filter(Boolean).join(",") || null,
      structured_result: {
        normalized_result: body,
        provider_outputs: telemetry.map((row) => ({ analysis_type: row.analysis_type, output: row.structured_output })),
      },
      usage: telemetry.map((row) => ({ analysis_type: row.analysis_type, usage: row.usage })),
      latency_ms: totalLatency,
    }).select("id").single();

    if (run?.id) {
      const mainOutput = telemetry.find((row) => row.analysis_type === "slab_identity")?.structured_output as { fields?: Record<string, any> } | undefined;
      const rawFields = mainOutput?.fields ?? {};
      const evidence = Object.entries(rawFields).map(([fieldName, field]: [string, any]) => ({
        analysis_run_id: run.id,
        owner_id: ownerId,
        field_name: fieldName,
        value: field.value,
        normalized_value: field.normalized_value,
        confidence: field.confidence,
        // Images are uploaded and linked only after the proposed slab is saved.
        // Preserve provider labels in structured_result; UUID evidence links are
        // populated by the save/link RPC rather than accepting arbitrary text.
        image_id: null,
        derivative_id: null,
        bounding_box: field.bounding_box,
        alternatives: field.alternatives,
        readability: field.readability,
      }));
      if (evidence.length > 0) await admin.from("ai_field_evidence").insert(evidence);
    }

    return {
      statusCode: 200,
      body: {
        ...body,
        analysis_version: SCHEMA_VERSION,
        model: String(telemetry[0]?.model ?? MODEL),
        provider: "OPENAI",
        analysis_run_id: run?.id ?? null,
        request_ids: telemetry.map((row) => row.request_id).filter(Boolean),
        latency_ms: totalLatency,
        overall_status: /disagree|could not read/i.test(body.warnings.join(" ")) ? "NEEDS_REVIEW" : "PROPOSED",
        images_evaluated: (input as { back_image_base64?: string }).back_image_base64 ? ["front_original", "back_original"] : ["front_original"],
        identity_conflicts: body.warnings.filter((warning: string) => /disagree|inconsistent|conflict/i.test(warning)),
        required_user_actions: body.warnings.length ? ["Review every flagged field against the original photograph before linking a product."] : [],
        search_queries: ((telemetry.find((row) => row.analysis_type === "slab_identity")?.structured_output as { search_queries?: string[] } | undefined)?.search_queries ?? []),
      },
    };
  } catch {
    return { statusCode: 502, body: { status: "error", error_code: "OPENAI_ANALYSIS_ERROR", message: "OpenAI image analysis failed safely; no fields were verified." } };
  }
}
