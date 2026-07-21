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

import { reconcileIdentity } from "../../lib/slabs/identity-normalize";

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
  "finish",
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
  /** Present when the Edge Function persisted the immutable analysis audit. */
  analysis_run_id?: string | null;
  analysis_version?: string;
  model?: string;
  provider?: string;
  overall_status?: "PROPOSED" | "NEEDS_REVIEW";
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
  images: Array<{ label: string; image: AnalyzeImage }>;
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
  variants?: Array<{ label: string; image_base64: string; mime: string }>;
  /** Server-only switch. Production Edge calls enable every independent pass. */
  strict_multi_pass?: boolean;
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
  "rarity is the printed rarity (e.g. \"Mega Attack Rare\"). finish is the print treatment " +
  "(e.g. \"Holo\", \"Reverse Holo\", \"Non-Holo\"). variation is the combined descriptor when the " +
  "card shows one (e.g. \"Mega Attack Rare - Holo\"). " +
  "COMPATIBLE READINGS ARE NOT CONFLICTS. A numeric grade \"10\" alongside a label \"PRISTINE\" " +
  "is grade=\"10\", grade_label=\"PRISTINE\" — never report that as a grade conflict. A rarity " +
  "\"Mega Attack Rare\" alongside a finish \"Holo\" may combine into variation " +
  "\"Mega Attack Rare - Holo\" — never report that as a variation conflict. Only a genuine " +
  "front-vs-back or label-vs-card DISAGREEMENT on the same field is a conflict. " +
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

const VERIFY_CERTIFICATION_SYSTEM_PROMPT =
  "You are independently re-verifying ONE field on a graded-card label: the " +
  "certification_number. This is a fresh examination. You are not shown and must " +
  "not infer any earlier prediction. Return only schema-conforming output.";

const VERIFY_CERTIFICATION_INSTRUCTION =
  "Look ONLY at the certification_number printed on the grading label. Read each " +
  "character independently and preserve leading zeros. Return the exact " +
  "certification_number schema. If glare, blur, size, or a confusable character " +
  "prevents a reliable reading, set readable=false and value=null. Never reconstruct " +
  "or guess a missing character.";

const VERIFY_CRITICAL_IDENTITY_SYSTEM_PROMPT =
  "You are independently rereading critical identity and artwork evidence on a graded-card slab. " +
  "This is a fresh examination. You are not shown any earlier transcription or marketplace candidate. " +
  "Return only schema-conforming output and never infer unreadable text.";

const VERIFY_CRITICAL_IDENTITY_INSTRUCTION =
  "Independently reread the critical identity fields card_name, grader, grade, language, and major variation. " +
  "Also describe only directly visible artwork evidence: character, composition, border, set symbol, collector number, " +
  "rarity marking, promo marking, and error/variation markings. If evidence is not readable or visible, return null; " +
  "never use outside product knowledge and never reconstruct a character or digit.";

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

async function reverifyCertificationNumber(
  deps: AnalyzeDeps,
  images: AnalyzeModelRequest["images"],
  proposed: AnalyzeProposal,
  warnings: string[],
): Promise<void> {
  const first = proposed.certification_number;
  let second: ProposedField;
  try {
    const text = await deps.callModel({
      system: VERIFY_CERTIFICATION_SYSTEM_PROMPT,
      instruction: VERIFY_CERTIFICATION_INSTRUCTION,
      images,
    });
    const parsed = JSON.parse(stripFence(text)) as Record<string, unknown>;
    second = mapField(parsed.certification_number);
  } catch {
    warnings.push("Certification number could not be independently reread. Verify every character against the original label photograph.");
    return;
  }
  if (!second.readable) {
    warnings.push("Certification number was not clear enough for an independent reread. Verify it manually from a closer, glare-free label photograph.");
    return;
  }
  const normalize = (value: string | null) => (value ?? "").replace(/\s+/g, "").toUpperCase();
  if (normalize(first.value) === normalize(second.value)) {
    proposed.certification_number = { ...first, confidence: Math.max(first.confidence, second.confidence, 0.95) };
    return;
  }
  proposed.certification_number = { value: null, confidence: 0, source: first.source, readable: false };
  warnings.push(
    `Certification number needs review: independent readings disagree ("${first.value}" vs "${second.value}"). ` +
      "Do not save a verified certification number until the original photograph resolves every character.",
  );
}

/**
 * Parse a grade reading into its numeric grade and (optional) designation token.
 * Self-contained (this module is bundled standalone for the Edge Function),
 * mirroring the semantics of normalizeDesignation in the PriceCharting grade map:
 * "10" and "Pristine 10" are the SAME numeric grade with a designation, not two
 * conflicting grades.
 */
function parseGradeReading(raw: string | null): { numeric: number | null; designation: string | null } {
  const s = (raw ?? "").trim();
  if (!s) return { numeric: null, designation: null };
  const m = s.match(/\d{1,2}(?:\.\d)?/);
  const n = m ? Number(m[0]) : NaN;
  const numeric = Number.isFinite(n) ? n : null;
  const lower = s.toLowerCase();
  let designation: string | null = null;
  if (/black\s*label/.test(lower)) designation = "BLACK LABEL";
  else if (lower.includes("pristine")) designation = "PRISTINE";
  else if (lower.includes("perfect")) designation = "PERFECT";
  else if (lower.includes("gem")) designation = "GEM MINT";
  return { numeric, designation };
}

export interface GradeReconciliation {
  grade: ProposedField;
  /** A designation extracted from either reading, to backfill grade_label. */
  grade_label_designation: string | null;
  warning: string | null;
}

/**
 * Reconcile two independent grade readings by SEMANTIC components (numeric grade
 * + designation), NOT literal strings. "10" and "Pristine 10" agree on grade 10
 * and yield grade="10" + a "PRISTINE" designation for grade_label — never a
 * conflict. Genuinely different numeric grades (9 vs 10, 9.5 vs 10) remain a
 * conflict that clears the grade for manual review. Never guesses a numeric grade
 * and never weakens the never-guess rule for a real disagreement.
 */
export function reconcileGradeReadings(first: ProposedField, second: ProposedField): GradeReconciliation {
  if (!first.readable || !second.readable) {
    return {
      grade: { value: null, confidence: 0, source: first.source, readable: false },
      grade_label_designation: null,
      warning: "grade needs review: independent readings could not both resolve the evidence.",
    };
  }
  const a = parseGradeReading(first.value);
  const b = parseGradeReading(second.value);
  if (a.numeric !== null && b.numeric !== null && a.numeric === b.numeric) {
    return {
      grade: {
        value: String(a.numeric), // canonical numeric only: "10", "9.5" (designation stripped)
        confidence: Math.max(first.confidence, second.confidence, 0.95),
        source: first.source,
        readable: true,
      },
      grade_label_designation: a.designation ?? b.designation,
      warning: null,
    };
  }
  return {
    grade: { value: null, confidence: 0, source: first.source, readable: false },
    grade_label_designation: null,
    warning: `grade needs review: independent readings disagree ("${first.value}" vs "${second.value}").`,
  };
}

/**
 * Reconcile two independent VARIATION readings. Variation is low-stakes identity
 * context: a benign cross-pass wording difference (e.g. "Holo" vs "RRR - Holo")
 * must NOT clear a readable variation, because that drops evidence like the foil
 * finish. Keep the first readable reading and warn; never report it unreadable
 * just because the two passes phrased it differently.
 */
export function reconcileVariationReadings(first: ProposedField, second: ProposedField): { variation: ProposedField; warning: string | null } {
  const norm = (v: string | null) => (v ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (first.readable && second.readable && norm(first.value) !== norm(second.value)) {
    return {
      variation: { ...first, confidence: Math.min(first.confidence, 0.9) },
      warning: `variation readings differ ("${first.value}" vs "${second.value}") — kept "${first.value}"; confirm against the label.`,
    };
  }
  if (first.readable && second.readable) {
    return { variation: { ...first, confidence: Math.max(first.confidence, second.confidence, 0.95) }, warning: null };
  }
  return { variation: first, warning: null }; // one side unreadable — keep original, never clear
}

async function reverifyCriticalIdentity(
  deps: AnalyzeDeps,
  images: AnalyzeModelRequest["images"],
  proposed: AnalyzeProposal,
  warnings: string[],
): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    const text = await deps.callModel({
      system: VERIFY_CRITICAL_IDENTITY_SYSTEM_PROMPT,
      instruction: VERIFY_CRITICAL_IDENTITY_INSTRUCTION,
      images,
    });
    parsed = JSON.parse(stripFence(text)) as Record<string, unknown>;
  } catch {
    warnings.push("Critical identity fields could not be independently reread. Review the original photograph before linking a product.");
    return;
  }

  const reread = (parsed.fields ?? {}) as Record<string, unknown>;
  const critical: AnalyzeFieldKey[] = ["card_name", "grader", "grade", "language", "variation"];
  const normalize = (value: string | null) => (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const key of critical) {
    const first = proposed[key];
    const second = mapField(reread[key]);
    if (!first.readable && !second.readable) continue;

    if (key === "grade") {
      // Compare grade by numeric value + designation, not literal string, so a
      // bare "10" and a "Pristine 10" are recognized as the SAME grade rather
      // than a conflict that clears the grade and drops the slab to ungraded.
      const rec = reconcileGradeReadings(first, second);
      proposed.grade = rec.grade;
      if (rec.warning) warnings.push(rec.warning);
      // Backfill the designation into grade_label WITHOUT overwriting an existing
      // readable label. AI evidence only — never invented.
      if (rec.grade_label_designation) {
        const label = proposed.grade_label;
        if (!label.readable || !(label.value ?? "").trim()) {
          proposed.grade_label = { value: rec.grade_label_designation, confidence: rec.grade.confidence, source: first.source, readable: true };
        }
      }
      continue;
    }

    if (key === "variation") {
      const rec = reconcileVariationReadings(first, second);
      proposed.variation = rec.variation;
      if (rec.warning) warnings.push(rec.warning);
      continue;
    }

    if (!first.readable || !second.readable || normalize(first.value) !== normalize(second.value)) {
      proposed[key] = { value: null, confidence: 0, source: first.source, readable: false };
      warnings.push(
        `${key} needs review: independent readings ${!first.readable || !second.readable ? "could not both resolve the evidence" : `disagree ("${first.value}" vs "${second.value}")`}.`,
      );
      continue;
    }
    proposed[key] = { ...first, confidence: Math.max(first.confidence, second.confidence, 0.95) };
  }
}

/**
 * Fold the deterministic identity reconciliation back into the proposal IN
 * PLACE. A field whose value normalization DERIVED from other present evidence
 * (e.g. variation composed from rarity + finish, or a designation split out of
 * "PRISTINE 10") becomes readable, carrying the confidence of the field it was
 * derived from — never higher, and never invented from nothing.
 */
function applyIdentityReconciliation(proposed: AnalyzeProposal): void {
  const reconciled = reconcileIdentity({
    grade: proposed.grade.value,
    grade_label: proposed.grade_label.value,
    rarity: proposed.rarity.value,
    finish: proposed.finish.value,
    variation: proposed.variation.value,
  });

  const sourceConfidence = Math.max(
    proposed.rarity.confidence,
    proposed.finish.confidence,
    proposed.variation.confidence,
    proposed.grade.confidence,
    proposed.grade_label.confidence,
  );

  const fold = (key: "grade" | "grade_label" | "rarity" | "finish" | "variation") => {
    const next = reconciled[key];
    const current = proposed[key];
    if (next.value === "") return; // reconciliation never blanks a field
    if (next.value === current.value) return; // unchanged
    proposed[key] = {
      value: next.value,
      // A derived value inherits the confidence of its source evidence; a value
      // merely split/canonicalized keeps at least its own confidence.
      confidence: next.derived ? Math.min(sourceConfidence, current.readable ? current.confidence || sourceConfidence : sourceConfidence) : Math.max(current.confidence, sourceConfidence),
      source: current.readable ? current.source : "label",
      readable: true,
    };
  };

  (["grade", "grade_label", "rarity", "finish", "variation"] as const).forEach(fold);
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
  for (const variant of input.variants ?? []) {
    if (!variant?.image_base64 || !ALLOWED_MIME.has(variant.mime)) continue;
    images.push({ label: variant.label, image: { base64: variant.image_base64, mime: variant.mime } });
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
  if (proposed.certification_number.readable) {
    await reverifyCertificationNumber(deps, images, proposed, warnings);
  }
  if (input.strict_multi_pass) {
    await reverifyCriticalIdentity(deps, images, proposed, warnings);
  }

  // Deterministic reconciliation of compatible readings (grade vs designation,
  // rarity/finish vs combined variation). Runs after every model pass so the
  // final proposal never presents "10" vs "PRISTINE 10" or "Holo" vs "Mega
  // Attack Rare - Holo" as a conflict — those are one fact, split or combined.
  applyIdentityReconciliation(proposed);

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
