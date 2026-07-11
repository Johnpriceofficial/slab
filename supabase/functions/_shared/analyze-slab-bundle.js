// AUTO-GENERATED — do not edit. Source: src/server/analyze-slab/handler.ts
// Regenerate with: node scripts/build-analyze-slab-edge-bundle.mjs


// src/server/analyze-slab/handler.ts
var ANALYZE_FIELD_KEYS = [
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
  "label_description"
];
var ALLOWED_MIME = /* @__PURE__ */ new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
var CARD_NUMBER_CONFIDENCE_WARN_THRESHOLD = 0.9;
var CARD_NUMBER_CONFIRMED_CONFIDENCE = 0.95;
var SYSTEM_PROMPT = "You are a meticulous trading-card grading assistant. You read graded-slab photos (e.g. PSA/BGS/CGC/SGC) and extract the card's identity. You NEVER guess: if a field is unreadable, mark it readable=false and value=null. You compare the slab LABEL against the visible CARD and report whether they match. You return ONLY strict JSON, no prose, no code fences.";
var INSTRUCTION = `Extract these fields from the slab photos and return JSON with this exact shape:
{
  "fields": {
    "<field>": { "value": <string|null>, "confidence": <0..1>, "source": "front|back|label|card|unknown", "readable": <bool> }
  },
  "label_matches_card": <true|false|null>,
  "overall_confidence": <0..1>,
  "warnings": [ <string> ]
}
Fields: ${ANALYZE_FIELD_KEYS.join(", ")}.
Rules: certification_number is a STRING — preserve leading zeros, never a number. The certification/serial number is printed on the grading company's label (CGC, PSA, BGS, SGC), usually a long digit string and often SMALL — look closely at the label and read it digit by digit. If any digit is uncertain, or the serial is too small/blurred/glared to read with confidence, set readable=false for certification_number and DO NOT guess (a wrong cert number is worse than a blank one). card_number is a STRING and MUST be read digit by digit against the printed numerator/denominator (e.g. "016/064"), never estimated from a quick glance. Digit pairs that are frequently confused in print — 0/6/8, 1/7, 3/5/8, 5/6 — are the single most common cause of a silently wrong card number. If any digit in the numerator could plausibly be one of a confusable pair, or is small/blurred/glared, you MUST report confidence <= 0.6 for card_number and add a warning naming the ambiguous digit(s) — do not report high confidence on a guess. A wrong card number causes a downstream product-match failure that looks just like a legitimate no-match, so hiding uncertainty behind a high confidence score is worse than flagging it. grade is ONLY the numeric grade as a STRING (e.g. "10", "9.5"). grade_label is the grader's DESIGNATION/TIER printed with it — e.g. CGC "PRISTINE" or "GEM MINT", PSA "GEM MT", BGS "PRISTINE"/"BLACK LABEL". From a label reading "PRISTINE 10", grade="10" and grade_label="PRISTINE". NEVER drop the designation or fold it into grade. If the label and the visible card disagree, set label_matches_card=false and add a warning. Flag any unreadable field instead of guessing.`;
var VERIFY_CARD_NUMBER_SYSTEM_PROMPT = 'You are independently re-verifying ONE specific field on a graded trading-card slab label: the card_number (numerator/denominator, e.g. "016/064"). Treat this as a fresh, independent examination — you have no memory of any prior reading, and you must not anchor on what a first pass might have guessed. You return ONLY strict JSON, no prose.';
var VERIFY_CARD_NUMBER_INSTRUCTION = 'Look ONLY at the card_number printed on the slab label. Read every digit individually. Digit pairs that are frequently confused in print — 0/6/8, 1/7, 3/5/8, 5/6 — are the most common source of a wrong reading; scrutinize each digit against these confusable pairs before deciding. Return ONLY this exact JSON shape: { "card_number": { "value": <string|null>, "confidence": <0..1>, "readable": <bool> } }. If any digit is genuinely ambiguous or the text is too small/blurred/glared to be certain, set readable=false and value=null — never guess the closest-looking digit.';
function clamp01(n) {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
function coerceSource(s) {
  return s === "front" || s === "back" || s === "label" || s === "card" ? s : "unknown";
}
function mapField(raw) {
  if (!raw || typeof raw !== "object") {
    return { value: null, confidence: 0, source: "unknown", readable: false };
  }
  const o = raw;
  const readable = o.readable !== false && o.value !== null && o.value !== void 0 && o.value !== "";
  const value = readable ? String(o.value) : null;
  return {
    value,
    confidence: readable ? clamp01(o.confidence) : 0,
    source: coerceSource(o.source),
    readable
  };
}
function stripFence(text) {
  const t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : t;
}
function canonicalizeCardNumber(raw) {
  return raw.trim().toLowerCase().split("/").map((part) => part.replace(/[^0-9a-z]/g, "").replace(/^0+(?=[0-9a-z])/, "")).join("/");
}
async function reverifyCardNumber(deps, images, proposed, warnings) {
  const first = proposed.card_number;
  let secondRaw;
  try {
    const text = await deps.callModel({
      system: VERIFY_CARD_NUMBER_SYSTEM_PROMPT,
      instruction: VERIFY_CARD_NUMBER_INSTRUCTION,
      images
    });
    const parsed = JSON.parse(stripFence(text));
    secondRaw = parsed.card_number;
  } catch {
    warnings.push(
      `Card number confidence is ${Math.round(first.confidence * 100)}% and the independent re-verification pass failed to run — verify every digit against the physical slab before running PriceCharting.`
    );
    return;
  }
  const second = mapField(secondRaw);
  if (!second.readable) {
    warnings.push(
      `Card number confidence is ${Math.round(first.confidence * 100)}% and an independent second-pass re-verification also could not read it reliably — verify every digit against the physical slab before running PriceCharting.`
    );
    return;
  }
  const firstCanon = first.value ? canonicalizeCardNumber(first.value) : null;
  const secondCanon = canonicalizeCardNumber(second.value ?? "");
  if (firstCanon !== null && firstCanon === secondCanon) {
    proposed.card_number = {
      ...first,
      confidence: Math.max(first.confidence, second.confidence, CARD_NUMBER_CONFIRMED_CONFIDENCE)
    };
    return;
  }
  proposed.card_number = { value: null, confidence: 0, source: first.source, readable: false };
  warnings.push(
    `Card number could not be verified: two independent readings disagree ("${first.value}" vs "${second.value}"). Enter the correct number manually after checking the physical slab — never guessing between disagreeing reads.`
  );
}
async function analyzeSlabImages(input, deps) {
  const images = [];
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
  let text;
  try {
    text = await deps.callModel({ system: SYSTEM_PROMPT, instruction: INSTRUCTION, images });
  } catch (e) {
    return err(502, "ANALYSIS_PROVIDER_ERROR", e instanceof Error ? e.message : "The analysis provider failed.");
  }
  let parsed;
  try {
    parsed = JSON.parse(stripFence(text));
  } catch {
    return err(502, "ANALYSIS_PARSE_ERROR", "The analysis provider returned an unreadable response.");
  }
  const rawFields = parsed.fields ?? {};
  const proposed = {};
  for (const key of ANALYZE_FIELD_KEYS) {
    proposed[key] = mapField(rawFields[key]);
  }
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter((w) => typeof w === "string") : [];
  const labelMatches = parsed.label_matches_card === true ? true : parsed.label_matches_card === false ? false : null;
  if (labelMatches === false) {
    warnings.unshift("The slab label and the visible card appear inconsistent — verify identity carefully.");
  }
  if (proposed.card_number.readable && proposed.card_number.confidence < CARD_NUMBER_CONFIDENCE_WARN_THRESHOLD) {
    await reverifyCardNumber(deps, images, proposed, warnings);
  }
  const unreadable = ANALYZE_FIELD_KEYS.filter((k) => !proposed[k].readable);
  if (unreadable.length > 0) {
    warnings.push(`Could not read: ${unreadable.join(", ")}. Enter these manually.`);
  }
  const body = {
    status: "success",
    proposed,
    overall_confidence: clamp01(parsed.overall_confidence),
    label_matches_card: labelMatches,
    warnings,
    requires_confirmation: true
  };
  return { statusCode: 200, body };
}
function err(statusCode, code, message) {
  return { statusCode, body: { status: "error", error_code: code, message } };
}
export {
  ANALYZE_FIELD_KEYS,
  analyzeSlabImages
};
