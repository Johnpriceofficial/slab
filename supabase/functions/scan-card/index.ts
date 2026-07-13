// GradedCardValue.com live camera scanner. Raw JPEG captures remain private in
// Supabase Storage and are analyzed server-side with strict Responses API
// Structured Outputs. The browser never receives the OpenAI key or service key.

import { createClient } from "npm:@supabase/supabase-js@2.110.2";
import { corsHeaders } from "../_shared/cors.ts";
import { forbiddenResponse, getCallerUser, unauthorizedResponse } from "../_shared/auth.ts";
import { consumeUserDailyQuota } from "../_shared/quota.ts";
import {
  CARD_SCAN_SCHEMA_VERSION,
  classifyCardScan,
  conditionNotes,
  isCardScanExtraction,
  normalizeCardNumber,
  normalizeIdentity,
  type CardScanExtraction,
} from "../_shared/card-scan-core.ts";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = Deno.env.get("OPENAI_SCAN_MODEL") ?? Deno.env.get("OPENAI_ANALYZE_MODEL") ?? "gpt-5.6-terra";
// Hard ceiling across all customer plans. Each profile's lower plan allowance
// is applied atomically by consume_user_daily_quota.
const DAILY_LIMIT = Number(Deno.env.get("SCAN_DAILY_LIMIT") ?? "300");
const MAX_BYTES = 10 * 1024 * 1024;
const BUCKET = "card-scans";

const extractionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["card_name", "set_name", "card_number", "rarity", "condition_issues", "confidence"],
  properties: {
    card_name: { type: "string" },
    set_name: { type: "string" },
    card_number: { type: "string" },
    rarity: { type: "string" },
    condition_issues: {
      type: "object",
      additionalProperties: false,
      required: ["whitening", "scratches", "centering_notes", "other"],
      properties: {
        whitening: { type: "string" },
        scratches: { type: "string" },
        centering_notes: { type: "string" },
        other: { type: "string" },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]") : "Unexpected scanner error.";
}

function extractOutputText(data: Record<string, unknown>): string {
  if (typeof data.output_text === "string") return data.output_text;
  for (const item of (Array.isArray(data.output) ? data.output : []) as Array<Record<string, unknown>>) {
    for (const part of (Array.isArray(item.content) ? item.content : []) as Array<Record<string, unknown>>) {
      if (part.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  throw new Error("OpenAI returned no structured output.");
}

async function analyzeCard(apiKey: string, bytes: Uint8Array): Promise<{
  extraction: CardScanExtraction;
  requestId: string | null;
  model: string;
  usage: unknown;
  latencyMs: number;
}> {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  const imageUrl = `data:image/jpeg;base64,${btoa(binary)}`;
  const started = Date.now();
  let lastStatus = 0;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        store: false,
        input: [{
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Identify the single physical Pokemon trading card visible in this camera capture.",
                "Transcribe only evidence that is actually visible. Extract the card name, set name, collector/card number, and rarity.",
                "Describe visible condition concerns conservatively: edge whitening, surface scratches, centering, and other issues.",
                "Do not invent unreadable text and do not infer condition hidden by glare, sleeves, or image blur.",
                "Confidence is a 0-1 score for the combined card identification, not image quality alone.",
              ].join(" "),
            },
            { type: "input_image", image_url: imageUrl, detail: "original" },
          ],
        }],
        text: { format: { type: "json_schema", name: "card_scan", strict: true, schema: extractionSchema } },
      }),
    });
    lastStatus = response.status;
    if (response.ok) {
      const data = await response.json() as Record<string, unknown>;
      const parsed = JSON.parse(extractOutputText(data)) as unknown;
      if (!isCardScanExtraction(parsed)) throw new Error("OpenAI structured output failed validation.");
      return {
        extraction: parsed,
        requestId: typeof data.id === "string" ? data.id : null,
        model: typeof data.model === "string" ? data.model : MODEL,
        usage: data.usage ?? null,
        latencyMs: Date.now() - started,
      };
    }
    if (response.status !== 429 && response.status < 500) break;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 500 * 2 ** attempt + Math.floor(Math.random() * 250))));
  }
  throw new Error(`OpenAI scan failed with HTTP ${lastStatus}.`);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

async function duplicatesFor(admin: ReturnType<typeof createClient>, userId: string, extraction: CardScanExtraction) {
  const { data, error } = await admin.from("cards")
    .select("id,card_name,set_name,card_number,created_at")
    .eq("created_by", userId)
    .eq("card_name_normalized", normalizeIdentity(extraction.card_name))
    .eq("set_name_normalized", normalizeIdentity(extraction.set_name))
    .eq("card_number_normalized", normalizeCardNumber(extraction.card_number))
    .limit(10);
  if (error) throw error;
  return data ?? [];
}

async function insertCard(admin: ReturnType<typeof createClient>, userId: string, scan: Record<string, unknown>, extraction: CardScanExtraction) {
  const { data, error } = await admin.from("cards").insert({
    created_by: userId,
    source_scan_id: scan.id,
    card_name: extraction.card_name.trim(),
    set_name: extraction.set_name.trim(),
    card_number: extraction.card_number.trim(),
    rarity: extraction.rarity.trim() || null,
    condition_notes: conditionNotes(extraction.condition_issues) || null,
    condition_issues: extraction.condition_issues,
    identification_confidence: extraction.confidence,
    scan_image_path: scan.image_storage_path,
  }).select("id,card_name,set_name,card_number,rarity,condition_notes,identification_confidence,created_at").single();
  if (error) throw error;
  await admin.from("card_scans").update({ status: "added", updated_at: new Date().toISOString() }).eq("id", scan.id);
  return data;
}

async function createReview(admin: ReturnType<typeof createClient>, userId: string, scanId: string, reason: string, extraction: CardScanExtraction) {
  const { error } = await admin.from("card_scan_reviews").insert({
    scan_id: scanId,
    created_by: userId,
    review_reason: reason,
    proposed_data: extraction,
  });
  if (error) throw error;
}

async function processCapture(req: Request, userId: string, admin: ReturnType<typeof createClient>): Promise<Response> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return json({ status: "error", error_code: "NOT_CONFIGURED", message: "OpenAI card scanning is not configured." }, 502);
  if (!(await consumeUserDailyQuota(userId, "scan-card-openai", DAILY_LIMIT))) {
    return json({ status: "error", error_code: "QUOTA_EXCEEDED", message: "Daily card-scan limit reached. Try again tomorrow." }, 429);
  }

  let form: FormData;
  try { form = await req.formData(); } catch { return json({ status: "error", error_code: "INVALID_MULTIPART", message: "A multipart image upload is required." }, 400); }
  const file = form.get("image");
  if (!(file instanceof File)) return json({ status: "error", error_code: "IMAGE_REQUIRED", message: "The image field is required." }, 400);
  if (file.size <= 0 || file.size > MAX_BYTES) return json({ status: "error", error_code: "IMAGE_SIZE", message: "Capture must be between 1 byte and 10 MB." }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isJpeg(bytes)) return json({ status: "error", error_code: "INVALID_IMAGE", message: "The capture is not a valid JPEG image." }, 415);

  const hash = await sha256(bytes);
  const scanId = crypto.randomUUID();
  const storagePath = `${userId}/${scanId}.jpg`;
  const { error: uploadError } = await admin.storage.from(BUCKET).upload(storagePath, bytes, {
    contentType: "image/jpeg",
    upsert: false,
    cacheControl: "0",
  });
  if (uploadError) return json({ status: "error", error_code: "STORAGE_UPLOAD", message: "The scan could not be stored securely." }, 502);

  const { data: scan, error: scanError } = await admin.from("card_scans").insert({
    id: scanId,
    created_by: userId,
    image_storage_path: storagePath,
    image_sha256: hash,
    mime_type: "image/jpeg",
    byte_size: bytes.byteLength,
  }).select("*").single();
  if (scanError) {
    await admin.storage.from(BUCKET).remove([storagePath]);
    return json({ status: "error", error_code: "SCAN_AUDIT", message: "The scan audit record could not be created." }, 502);
  }

  try {
    const result = await analyzeCard(apiKey, bytes);
    const extraction = result.extraction;
    const duplicates = await duplicatesFor(admin, userId, extraction);
    const hasRequiredIdentity = [extraction.card_name, extraction.set_name, extraction.card_number]
      .every((value) => value.trim().length > 0);
    const decision = hasRequiredIdentity ? classifyCardScan(extraction.confidence, duplicates.length) : "needs_review";
    const status = decision === "auto_add" ? "processing" : decision;
    const { error: updateError } = await admin.from("card_scans").update({
      card_name: extraction.card_name,
      set_name: extraction.set_name,
      card_number: extraction.card_number,
      rarity: extraction.rarity || null,
      condition_issues: extraction.condition_issues,
      confidence: extraction.confidence,
      status,
      model: result.model,
      openai_request_id: result.requestId,
      openai_usage: result.usage,
      latency_ms: result.latencyMs,
      raw_result: extraction,
      updated_at: new Date().toISOString(),
    }).eq("id", scanId);
    if (updateError) throw updateError;

    if (decision === "auto_add") {
      const card = await insertCard(admin, userId, scan, extraction);
      await admin.from("audit_log").insert({ actor_user_id: userId, action: "card_scan_auto_added", entity_type: "card", entity_id: card.id, source: "OPENAI", detail: { scan_id: scanId, confidence: extraction.confidence } });
      return json({ status: "added", scan_id: scanId, extraction, card, duplicates: [] });
    }

    await createReview(admin, userId, scanId, decision === "needs_review" ? "low_confidence" : "possible_duplicate", extraction);
    return json({ status: decision, scan_id: scanId, extraction, duplicates });
  } catch (error) {
    await admin.from("card_scans").update({ status: "failed", error_code: "ANALYSIS_FAILED", updated_at: new Date().toISOString() }).eq("id", scanId);
    return json({ status: "error", error_code: "ANALYSIS_FAILED", message: safeMessage(error), scan_id: scanId }, 502);
  }
}

function correctedExtraction(scan: Record<string, unknown>, input: Record<string, unknown>): CardScanExtraction | null {
  const base = (scan.raw_result ?? {}) as Record<string, unknown>;
  const candidate = {
    ...base,
    card_name: typeof input.card_name === "string" ? input.card_name : base.card_name,
    set_name: typeof input.set_name === "string" ? input.set_name : base.set_name,
    card_number: typeof input.card_number === "string" ? input.card_number : base.card_number,
    rarity: typeof input.rarity === "string" ? input.rarity : base.rarity,
  };
  return isCardScanExtraction(candidate) ? candidate : null;
}

async function handleAction(body: Record<string, unknown>, userId: string, admin: ReturnType<typeof createClient>): Promise<Response> {
  const action = body.action;
  if (action === "card_summary") {
    const [activeResult, archivedResult, reviewsResult] = await Promise.all([
      admin.from("cards").select("id", { count: "exact", head: true }).eq("created_by", userId).eq("inventory_status", "active"),
      admin.from("cards").select("id", { count: "exact", head: true }).eq("created_by", userId).eq("inventory_status", "archived"),
      admin.from("card_scan_reviews").select("id", { count: "exact", head: true }).eq("created_by", userId).eq("status", "pending"),
    ]);
    if (activeResult.error) throw activeResult.error;
    if (archivedResult.error) throw archivedResult.error;
    if (reviewsResult.error) throw reviewsResult.error;
    return json({
      status: "success",
      active: activeResult.count ?? 0,
      archived: archivedResult.count ?? 0,
      needs_review: reviewsResult.count ?? 0,
    });
  }

  if (action === "list_cards") {
    const requestedStatus = body.inventory_status === "archived" ? "archived" : "active";
    const { data: cards, error } = await admin.from("cards")
      .select("id,card_name,set_name,card_number,rarity,condition_notes,identification_confidence,scan_image_path,inventory_status,created_at,updated_at")
      .eq("created_by", userId).eq("inventory_status", requestedStatus)
      .order("created_at", { ascending: false }).limit(500);
    if (error) throw error;
    const paths = (cards ?? []).map((card) => card.scan_image_path).filter(Boolean);
    const { data: signedRows } = paths.length ? await admin.storage.from(BUCKET).createSignedUrls(paths, 600) : { data: [] };
    const signedByPath = new Map((signedRows ?? []).map((row) => [row.path, row.signedUrl]));
    return json({ status: "success", cards: (cards ?? []).map((card) => ({ ...card, thumbnail_url: signedByPath.get(card.scan_image_path) ?? null })) });
  }

  if (action === "get_card") {
    const cardId = typeof body.card_id === "string" ? body.card_id : "";
    if (!cardId) return json({ status: "error", error_code: "CARD_ID_REQUIRED", message: "card_id is required." }, 400);
    const { data: card, error } = await admin.from("cards")
      .select("id,source_scan_id,card_name,set_name,card_number,rarity,condition_notes,condition_issues,identification_confidence,scan_image_path,inventory_status,created_at,updated_at")
      .eq("id", cardId).eq("created_by", userId).single();
    if (error || !card) return json({ status: "error", error_code: "CARD_NOT_FOUND", message: "Card not found." }, 404);
    const { data: scan } = await admin.from("card_scans")
      .select("model,openai_request_id,latency_ms,schema_version,created_at")
      .eq("id", card.source_scan_id).eq("created_by", userId).single();
    const { data: signed } = await admin.storage.from(BUCKET).createSignedUrl(card.scan_image_path, 600);
    return json({ status: "success", card: { ...card, image_url: signed?.signedUrl ?? null, scan: scan ?? null } });
  }

  if (action === "update_card") {
    const cardId = typeof body.card_id === "string" ? body.card_id : "";
    const extraction = {
      card_name: typeof body.card_name === "string" ? body.card_name.trim() : "",
      set_name: typeof body.set_name === "string" ? body.set_name.trim() : "",
      card_number: typeof body.card_number === "string" ? body.card_number.trim() : "",
      rarity: typeof body.rarity === "string" ? body.rarity.trim() : "",
    };
    if (!cardId || !extraction.card_name || !extraction.set_name || !extraction.card_number) {
      return json({ status: "error", error_code: "INVALID_CARD", message: "Card name, set, and number are required." }, 400);
    }
    const { data: owned } = await admin.from("cards").select("id").eq("id", cardId).eq("created_by", userId).single();
    if (!owned) return json({ status: "error", error_code: "CARD_NOT_FOUND", message: "Card not found." }, 404);
    const { data: duplicates, error: duplicateError } = await admin.from("cards").select("id,card_name,set_name,card_number")
      .eq("created_by", userId)
      .eq("card_name_normalized", normalizeIdentity(extraction.card_name))
      .eq("set_name_normalized", normalizeIdentity(extraction.set_name))
      .eq("card_number_normalized", normalizeCardNumber(extraction.card_number))
      .neq("id", cardId).limit(10);
    if (duplicateError) throw duplicateError;
    if ((duplicates?.length ?? 0) > 0 && body.allow_duplicate !== true) {
      return json({ status: "possible_duplicate", duplicates });
    }
    const { data: card, error } = await admin.from("cards").update({
      card_name: extraction.card_name,
      set_name: extraction.set_name,
      card_number: extraction.card_number,
      rarity: extraction.rarity || null,
      condition_notes: typeof body.condition_notes === "string" ? body.condition_notes.trim() || null : null,
      updated_at: new Date().toISOString(),
    }).eq("id", cardId).eq("created_by", userId)
      .select("id,card_name,set_name,card_number,rarity,condition_notes,inventory_status,updated_at").single();
    if (error) throw error;
    await admin.from("audit_log").insert({ actor_user_id: userId, action: "card_inventory_updated", entity_type: "card", entity_id: cardId, source: "USER", detail: { duplicate_override: (duplicates?.length ?? 0) > 0 } });
    return json({ status: "success", card });
  }

  if (action === "archive_card" || action === "restore_card") {
    const cardId = typeof body.card_id === "string" ? body.card_id : "";
    if (!cardId) return json({ status: "error", error_code: "CARD_ID_REQUIRED", message: "card_id is required." }, 400);
    const inventoryStatus = action === "archive_card" ? "archived" : "active";
    const { data: card, error } = await admin.from("cards").update({ inventory_status: inventoryStatus, updated_at: new Date().toISOString() })
      .eq("id", cardId).eq("created_by", userId).select("id,inventory_status").single();
    if (error || !card) return json({ status: "error", error_code: "CARD_NOT_FOUND", message: "Card not found." }, 404);
    await admin.from("audit_log").insert({ actor_user_id: userId, action: action === "archive_card" ? "card_inventory_archived" : "card_inventory_restored", entity_type: "card", entity_id: cardId, source: "USER" });
    return json({ status: "success", card });
  }

  if (action === "list_reviews") {
    const { data: reviews, error } = await admin.from("card_scan_reviews")
      .select("id,scan_id,review_reason,proposed_data,status,created_at")
      .eq("created_by", userId).eq("status", "pending").order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    const rows = await Promise.all((reviews ?? []).map(async (review) => {
      const { data: scan } = await admin.from("card_scans").select("image_storage_path,confidence,status").eq("id", review.scan_id).eq("created_by", userId).single();
      const { data: signed } = scan?.image_storage_path
        ? await admin.storage.from(BUCKET).createSignedUrl(scan.image_storage_path, 600)
        : { data: null };
      return { ...review, scan_status: scan?.status ?? null, confidence: scan?.confidence ?? null, thumbnail_url: signed?.signedUrl ?? null };
    }));
    return json({ status: "success", reviews: rows });
  }

  const scanId = typeof body.scan_id === "string" ? body.scan_id : "";
  if (!scanId) return json({ status: "error", error_code: "SCAN_ID_REQUIRED", message: "scan_id is required." }, 400);
  const { data: scan, error: scanError } = await admin.from("card_scans").select("*").eq("id", scanId).eq("created_by", userId).single();
  if (scanError || !scan) return json({ status: "error", error_code: "SCAN_NOT_FOUND", message: "Scan not found." }, 404);

  if (action === "skip") {
    await admin.from("card_scans").update({ status: "skipped", updated_at: new Date().toISOString() }).eq("id", scanId);
    await admin.from("card_scan_reviews").update({ status: "skipped", resolved_by: userId, resolved_at: new Date().toISOString() }).eq("scan_id", scanId).eq("status", "pending");
    await admin.from("audit_log").insert({ actor_user_id: userId, action: "card_scan_skipped", entity_type: "card_scan", entity_id: scanId, source: "USER" });
    return json({ status: "skipped", scan_id: scanId });
  }

  if (action === "confirm") {
    const extraction = correctedExtraction(scan, body);
    if (!extraction) return json({ status: "error", error_code: "INVALID_CORRECTION", message: "Card name, set, and number are required." }, 400);
    const { data: existing } = await admin.from("cards").select("id").eq("source_scan_id", scanId).maybeSingle();
    if (existing) return json({ status: "added", scan_id: scanId, card: existing, extraction });
    const duplicates = await duplicatesFor(admin, userId, extraction);
    if (duplicates.length > 0 && body.add_anyway !== true) {
      return json({ status: "possible_duplicate", scan_id: scanId, extraction, duplicates });
    }
    const card = await insertCard(admin, userId, scan, extraction);
    await admin.from("card_scan_reviews").update({
      status: "confirmed", corrected_data: extraction, resolved_by: userId, resolved_at: new Date().toISOString(),
    }).eq("scan_id", scanId).eq("status", "pending");
    await admin.from("audit_log").insert({ actor_user_id: userId, action: "card_scan_confirmed", entity_type: "card", entity_id: card.id, source: "USER", detail: { scan_id: scanId, duplicate_override: duplicates.length > 0 } });
    return json({ status: "added", scan_id: scanId, extraction, card, duplicate_override: duplicates.length > 0 });
  }

  return json({ status: "error", error_code: "INVALID_ACTION", message: "Unknown scanner action." }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ status: "error", error_code: "METHOD_NOT_ALLOWED", message: "POST required." }, 405);
  const user = await getCallerUser(req);
  if (!user) return unauthorizedResponse(corsHeaders);
  if (!user.email_confirmed_at) return forbiddenResponse(corsHeaders, "Verify your email before using the scanner.");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: profile, error: profileError } = await admin.from("customer_profiles")
    .select("account_status")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) return json({ status: "error", error_code: "ACCOUNT_LOOKUP_FAILED", message: "Account status could not be verified." }, 503);
  if (!profile || profile.account_status !== "active") {
    return forbiddenResponse(corsHeaders, "This customer account is not active.");
  }

  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) return await processCapture(req, user.id, admin);
    const body = await req.json() as Record<string, unknown>;
    return await handleAction(body, user.id, admin);
  } catch (error) {
    return json({ status: "error", error_code: "SCAN_CARD_ERROR", message: safeMessage(error) }, 500);
  }
});
