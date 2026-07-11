/**
 * Server-side slab image analysis — framework-agnostic core.
 *
 * Runs in Node (vitest) AND, once bundled, inside the Supabase Edge Function
 * `analyze-slab`. The AI-provider secret NEVER reaches the browser: the browser
 * sends image bytes to the Edge Function, which injects the key when calling the
 * model. This module is pure — it builds the prompt, parses the model's reply,
 * and normalizes it into a strongly-typed *proposal*.
 *
 * Hard rules encoded here:
 *   - Output is PROPOSED data only. `requires_confirmation` is always true; the
 *     operator must confirm or edit every field before any PriceCharting lookup
 *     or inventory save. Nothing here writes to the database.
 *   - Certification numbers are preserved as text (leading zeros survive).
 *   - Unreadable fields are FLAGGED (readable=false, value=null), never guessed.
 *   - A label-vs-card mismatch surfaces as a warning, not a silent choice.
 */

export type FieldSource = "front" | "back" | "label" | "card" | "unknown";

export interface ProposedField {
  value: string | null;
  /** Model's extraction confidence for this field, clamped to [0, 1]. */
  confidence: number;
  source: FieldSource;
  /** false when the field could not be read; value is then null and flagged. */
  readable: boolean;
}

export const ANALYZE_FIELD_KEYS = [
  "card_name",
  "set",
  "card_number",
  "year",
  "language",
  "rarity",
  "variation",
  "grader",
  "grade",
  "certification_number",
  "label_description",
] as const;

export type AnalyzeFieldKey = (typeof ANALYZE_FIELD_KEYS)[number];

export type AnalyzeProposal = Record<AnalyzeFieldKey, ProposedField>;

export interface AnalyzeResult {
  status: "success";
  proposed: AnalyzeProposal;
  /** Overall extraction confidence, clamped to [0, 1]. */
  overall_confidence: number;
  /** true/false when comparable; null when the model could not compare. */
  label_matches_card: boolean | null;
  warnings: string[];
  /** Always true: extracted values must be human-confirmed before use. */
  requires_confirmation: true;
}

export interface AnalyzeErrorBody {
  status: "error";
  error_code: string;
  message: string;
}

export interface AnalyzeHandlerResult {
  statusCode: number;
  body: AnalyzeResult | AnalyzeErrorBody;
}

export interface AnalyzeImage {
  base64: string;
  mime: string;
}

export interface AnalyzeModelRequest {
  system: string;
  instruction: string;
  images: Array<{ label: "front" | "back"; image: AnalyzeImage }>;
}

export interface AnalyzeDeps {
  /** Calls the vision model; returns the model's raw text reply (expected JSON). */
  callModel: (req: AnalyzeModelRequest) => Promise<string>;
}

export interface AnalyzeInput {
  front_image_base64?: string;
  front_mime?: string;
  back_image_base64?: string;
  back_mime?: string;
}

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

const SYSTEM_PROMPT =
  "You are a meticulous trading-card grading assistant. You read graded-slab " +
  "photos (e.g. PSA/BGS/CGC/SGC) and extract the card's identity. You NEVER " +
  "guess: if a field is unreadable, mark it readable=false and value=null. You " +
  "compare the slab LABEL against the visible CARD and report whether they " +
  "match. You return ONLY strict JSON, no prose, no code fences.";

const INSTRUCTION =
  "Extract these fields from the slab photos and return JSON with this exact shape:\n" +
  "{\n" +
  '  "fields": {\n' +
  '    "<field>": { "value": <string|null>, "confidence": <0..1>, "source": "front|back|label|card|unknown", "readable": <bool> }\n' +
  "  },\n" +
  '  "label_matches_card": <true|false|null>,\n' +
  '  "overall_confidence": <0..1>,\n' +
  '  "warnings": [ <string> ]\n' +
  "}\n" +
  `Fields: ${ANALYZE_FIELD_KEYS.join(", ")}.\n` +
  "Rules: certification_number is a STRING — preserve leading zeros, never a number. " +
  "The certification/serial number is printed on the grading company's label (CGC, PSA, " +
  "BGS, SGC), usually a long digit string and often SMALL — look closely at the label and " +
  "read it digit by digit. If any digit is uncertain, or the serial is too small/blurred/" +
  "glared to read with confidence, set readable=false for certification_number and DO NOT " +
  "guess (a wrong cert number is worse than a blank one). " +
  "grade is a STRING (e.g. \"10\", \"9.5\"). If the label and the visible card disagree, " +
  "set label_matches_card=false and add a warning. Flag any unreadable field instead of guessing.";

function clamp01(n: unknown): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function coerceSource(s: unknown): FieldSource {
  return s === "front" || s === "back" || s === "label" || s === "card" ? s : "unknown";
}

/** Map one raw field object into a normalized ProposedField (defensive). */
function mapField(raw: unknown): ProposedField {
  if (!raw || typeof raw !== "object") {
    return { value: null, confidence: 0, source: "unknown", readable: false };
  }
  const o = raw as Record<string, unknown>;
  const readable = o.readable !== false && o.value !== null && o.value !== undefined && o.value !== "";
  // Certification and every field are preserved as text; never coerce to number.
  const value = readable ? String(o.value) : null;
  return {
    value,
    confidence: readable ? clamp01(o.confidence) : 0,
    source: coerceSource(o.source),
    readable,
  };
}

/** Strip a ```json code fence if the model wrapped its reply in one. */
function stripFence(text: string): string {
  const t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : t;
}

export async function analyzeSlabImages(input: AnalyzeInput, deps: AnalyzeDeps): Promise<AnalyzeHandlerResult> {
  const images: AnalyzeModelRequest["images"] = [];

  if (!input.front_image_base64 || !input.front_mime) {
    return err(400, "MISSING_IMAGE", "A front image is required to analyze a slab.");
  }
  if (!ALLOWED_MIME.has(input.front_mime)) {
    return err(400, "UNSUPPORTED_IMAGE", `Unsupported front image type: ${input.front_mime}.`);
  }
  images.push({ label: "front", image: { base64: input.front_image_base64, mime: input.front_mime } });

  if (input.back_image_base64 && input.back_mime) {
    if (!ALLOWED_MIME.has(input.back_mime)) {
      return err(400, "UNSUPPORTED_IMAGE", `Unsupported back image type: ${input.back_mime}.`);
    }
    images.push({ label: "back", image: { base64: input.back_image_base64, mime: input.back_mime } });
  }

  let text: string;
  try {
    text = await deps.callModel({ system: SYSTEM_PROMPT, instruction: INSTRUCTION, images });
  } catch (e) {
    return err(502, "ANALYSIS_PROVIDER_ERROR", e instanceof Error ? e.message : "The analysis provider failed.");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripFence(text)) as Record<string, unknown>;
  } catch {
    return err(502, "ANALYSIS_PARSE_ERROR", "The analysis provider returned an unreadable response.");
  }

  const rawFields = (parsed.fields ?? {}) as Record<string, unknown>;
  const proposed = {} as AnalyzeProposal;
  for (const key of ANALYZE_FIELD_KEYS) {
    proposed[key] = mapField(rawFields[key]);
  }

  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string")
    : [];

  const labelMatches =
    parsed.label_matches_card === true ? true : parsed.label_matches_card === false ? false : null;
  if (labelMatches === false) {
    warnings.unshift("The slab label and the visible card appear inconsistent — verify identity carefully.");
  }
  // Surface unreadable fields explicitly so the operator knows what to fill in.
  const unreadable = ANALYZE_FIELD_KEYS.filter((k) => !proposed[k].readable);
  if (unreadable.length > 0) {
    warnings.push(`Could not read: ${unreadable.join(", ")}. Enter these manually.`);
  }

  const body: AnalyzeResult = {
    status: "success",
    proposed,
    overall_confidence: clamp01(parsed.overall_confidence),
    label_matches_card: labelMatches,
    warnings,
    requires_confirmation: true,
  };
  return { statusCode: 200, body };
}

function err(statusCode: number, code: string, message: string): AnalyzeHandlerResult {
  return { statusCode, body: { status: "error", error_code: code, message } };
}
