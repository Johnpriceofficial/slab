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
 *   - card_number ALWAYS gets an automatic SECOND, independent re-verification
 *     call (same provider, a fresh prompt, no memory of the first reading)
 *     whenever it's readable — regardless of the first pass's self-reported
 *     confidence.
 *
 *     WHY UNCONDITIONAL, NOT CONFIDENCE-GATED: an earlier version only
 *     escalated when confidence < 0.9. Live production data disproved that the
 *     self-reported confidence is trustworthy enough to gate on: the model
 *     returned card_number "015/064" at 95% confidence while its OWN warning
 *     text said "digit '1' and '5' could be misread — verify against the
 *     card" — a direct self-contradiction that a confidence threshold cannot
 *     catch, because the number itself claimed to be confident. The real
 *     card was 016/064 (confirmed against PriceCharting/TCGplayer/eBay/
 *     Cardmarket). A fresh independent re-read reliably produced "016/064"
 *     when tested against the same photo, so the fix is to never rely on a
 *     single self-reported score for this field — always cross-check it
 *     against a second, independent read.
 *
 *       - Both passes agree            -> CONFIRMED: confidence raised, no warning.
 *       - Passes disagree              -> NEVER guess: field is cleared
 *         (readable=false, value=null) and a warning names both candidate
 *         readings so the operator resolves it manually.
 *       - Second pass also can't read it -> original warning stands, now
 *         noting a second pass didn't help either.
 *       - Second-pass call itself fails  -> falls back to the original
 *         warning rather than failing the whole analysis.
 *     A misread digit here looks identical to a legitimate PriceCharting
 *     no-match once it reaches the matcher, so resolving the ambiguity BEFORE
 *     the operator searches is the whole point.
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
  "grade_label",
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

/** Confidence assigned once two independent passes agree on card_number. */
const CARD_NUMBER_CONFIRMED_CONFIDENCE = 0.95;

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
  "card_number is a STRING and MUST be read digit by digit against the printed numerator/" +
  "denominator (e.g. \"016/064\"), never estimated from a quick glance. Digit pairs that are " +
  "frequently confused in print — 0/6/8, 1/7, 3/5/8, 5/6 — are the single most common cause " +
  "of a silently wrong card number. If any digit in the numerator could plausibly be one of a " +
  "confusable pair, or is small/blurred/glared, you MUST report confidence <= 0.6 for " +
  "card_number and add a warning naming the ambiguous digit(s) — do not report high confidence " +
  "on a guess. A wrong card number causes a downstream product-match failure that looks just " +
  "like a legitimate no-match, so hiding uncertainty behind a high confidence score is worse " +
  "than flagging it. This field is independently re-verified regardless of the confidence you " +
  "report, so report your GENUINE confidence rather than inflating it. " +
  "grade is ONLY the numeric grade as a STRING (e.g. \"10\", \"9.5\"). grade_label is the " +
  "grader's DESIGNATION/TIER printed with it — e.g. CGC \"PRISTINE\" or \"GEM MINT\", PSA " +
  "\"GEM MT\", BGS \"PRISTINE\"/\"BLACK LABEL\". From a label reading \"PRISTINE 10\", grade=\"10\" " +
  "and grade_label=\"PRISTINE\". NEVER drop the designation or fold it into grade. " +
  "If the label and the visible card disagree, " +
  "set label_matches_card=false and add a warning. Flag any unreadable field instead of guessing.";

const VERIFY_CARD_NUMBER_SYSTEM_PROMPT =
  "You are independently re-verifying ONE specific field on a graded trading-card slab " +
  "label: the card_number (numerator/denominator, e.g. \"016/064\"). Treat this as a fresh, " +
  "independent examination — you have no memory of any prior reading, and you must not " +
  "anchor on what a first pass might have guessed. You return ONLY strict JSON, no prose.";

const VERIFY_CARD_NUMBER_INSTRUCTION =
  "Look ONLY at the card_number printed on the slab label. Read every digit individually. " +
  "Digit pairs that are frequently confused in print — 0/6/8, 1/7, 3/5/8, 5/6 — are the most " +
  "common source of a wrong reading; scrutinize each digit against these confusable pairs " +
  "before deciding. Return ONLY this exact JSON shape: " +
  '{ "card_number": { "value": <string|null>, "confidence": <0..1>, "readable": <bool> } }. ' +
  "If any digit is genuinely ambiguous or the text is too small/blurred/glared to be certain, " +
  "set readable=false and value=null — never guess the closest-looking digit.";

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

/**
 * Canonicalize a card number for AGREEMENT comparison only (self-contained —
 * deliberately duplicated rather than imported from src/lib/pricecharting/
 * card-number.ts, since this module is bundled standalone for the Edge
 * Function). Strips everything but digits/letters, lowercases, and drops
 * leading zeros from each slash-separated part so "016/064" === "16/64".
 */
function canonicalizeCardNumber(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .split("/")
    .map((part) => part.replace(/[^0-9a-z]/g, "").replace(/^0+(?=[0-9a-z])/, ""))
    .join("/");
}

/**
 * Fire the second, independent card_number re-verification call and fold the
 * result into `proposed` + `warnings` IN PLACE. Never guesses: agreement
 * upgrades confidence, disagreement clears the field for manual entry, and an
 * unreadable second pass leaves the original reading + warning intact.
 */
async function reverifyCardNumber(
  deps: AnalyzeDeps,
  images: AnalyzeModelRequest["images"],
  proposed: AnalyzeProposal,
  warnings: string[],
): Promise<void> {
  const first = proposed.card_number;

  let secondRaw: unknown;
  try {
    const text = await deps.callModel({
      system: VERIFY_CARD_NUMBER_SYSTEM_PROMPT,
      instruction: VERIFY_CARD_NUMBER_INSTRUCTION,
      images,
    });
    const parsed = JSON.parse(stripFence(text)) as Record<string, unknown>;
    secondRaw = parsed.card_number;
  } catch {
    // Verification call failed outright — fall back to a plain warning rather
    // than blocking the whole analysis on a second-pass hiccup.
    warnings.push(
      `Card number "${first.value}" (first-pass confidence ${Math.round(first.confidence * 100)}%) ` +
        "could not be independently re-verified (the verification call failed to run) — verify " +
        "every digit against the physical slab before running PriceCharting.",
    );
    return;
  }

  const second = mapField(secondRaw);

  if (!second.readable) {
    // Second pass couldn't confirm it either — original reading stands, now
    // noting that independent re-verification didn't resolve the ambiguity.
    warnings.push(
      `Card number "${first.value}" (first-pass confidence ${Math.round(first.confidence * 100)}%) ` +
        "could not be confirmed by an independent second-pass re-verification — verify every digit " +
        "against the physical slab before running PriceCharting.",
    );
    return;
  }

  const firstCanon = first.value ? canonicalizeCardNumber(first.value) : null;
  const secondCanon = canonicalizeCardNumber(second.value ?? "");

  if (firstCanon !== null && firstCanon === secondCanon) {
    // Two independent passes agree — confirmed. Raise confidence, no warning.
    proposed.card_number = {
      ...first,
      confidence: Math.max(first.confidence, second.confidence, CARD_NUMBER_CONFIRMED_CONFIDENCE),
    };
    return;
  }

  // Passes DISAGREE. Per the never-guess rule: do not silently pick either
  // reading — including the first pass's own self-reported confidence, which
  // is exactly what caused the original bug (a wrong number reported at 95%
  // confidence). Clear the field and require manual resolution, naming both
  // candidates so the operator isn't starting from zero.
  proposed.card_number = { value: null, confidence: 0, source: first.source, readable: false };
  warnings.push(
    `Card number could not be verified: two independent readings disagree (` +
      `"${first.value}" vs "${second.value}"). Enter the correct number manually after checking ` +
      "the physical slab — never guessing between disagreeing reads.",
  );
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

  // ALWAYS independently re-verify card_number when it's readable — never gate
  // this on the first pass's self-reported confidence (see module doc comment
  // for the live production case that disproved that gate). Mutates
  // `proposed.card_number` and `warnings` in place.
  if (proposed.card_number.readable) {
    await reverifyCardNumber(deps, images, proposed, warnings);
  }

  // Surface unreadable fields explicitly so the operator knows what to fill in
  // (computed AFTER re-verification, since that step can clear card_number).
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
