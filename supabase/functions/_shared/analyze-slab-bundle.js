// AUTO-GENERATED — do not edit. Source: src/server/analyze-slab/handler.ts
// Regenerate with: node scripts/build-analyze-slab-edge-bundle.mjs


// src/lib/slabs/identity-normalize.ts
function normalizeGrade(raw) {
  const text = (raw ?? "").trim();
  if (!text) return { grade: "", grade_label: "" };
  const match = text.match(/(?<![\d.])\d{1,2}(?:\.\d)?(?![\d.])/);
  const grade = match ? match[0] : "";
  const label = (match ? text.replace(match[0], " ") : text).replace(/\s+/g, " ").trim();
  return { grade, grade_label: label };
}
function normalizeVariation(parts) {
  let rarity = (parts.rarity ?? "").trim();
  let finish = (parts.finish ?? "").trim();
  let variation = (parts.variation ?? "").trim();
  if (!variation && rarity && finish) {
    variation = `${rarity} - ${finish}`;
  } else if (!variation && rarity && !finish) {
    variation = rarity;
  }
  if (variation.includes(" - ")) {
    const [head, ...rest] = variation.split(" - ");
    const tail = rest.join(" - ").trim();
    if (!rarity && head.trim()) rarity = head.trim();
    if (!finish && tail) finish = tail;
  } else if (variation && finish && !rarity && variation.toLowerCase().endsWith(finish.toLowerCase())) {
    const stripped = variation.slice(0, variation.length - finish.length).replace(/[-\s]+$/, "").trim();
    if (stripped) rarity = stripped;
  }
  return { rarity, finish, variation };
}
function reconcileIdentity(input) {
  const rawGrade = (input.grade ?? "").trim();
  const rawLabel = (input.grade_label ?? "").trim();
  const fromGrade = normalizeGrade(rawGrade);
  const fromLabel = normalizeGrade(rawLabel);
  const grade = fromGrade.grade || fromLabel.grade;
  const grade_label = fromLabel.grade_label || fromGrade.grade_label;
  const variation = normalizeVariation({
    rarity: input.rarity,
    finish: input.finish,
    variation: input.variation
  });
  const field = (value, ...sources) => ({
    value,
    derived: value !== "" && !sources.some((s) => (s ?? "").trim() === value)
  });
  return {
    grade: field(grade, rawGrade),
    grade_label: field(grade_label, rawLabel),
    rarity: field(variation.rarity, input.rarity),
    finish: field(variation.finish, input.finish),
    variation: field(variation.variation, input.variation)
  };
}

// src/server/analyze-slab/handler.ts
var ANALYZE_FIELD_KEYS = [
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
  "label_description"
];
var ALLOWED_MIME = /* @__PURE__ */ new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
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
Rules: certification_number is a STRING — preserve leading zeros, never a number. The certification/serial number is printed on the grading company's label (CGC, PSA, BGS, SGC), usually a long digit string and often SMALL — look closely at the label and read it digit by digit. If any digit is uncertain, or the serial is too small/blurred/glared to read with confidence, set readable=false for certification_number and DO NOT guess (a wrong cert number is worse than a blank one). card_number is a STRING and MUST be read digit by digit against the printed numerator/denominator (e.g. "016/064"), never estimated from a quick glance. Digit pairs that are frequently confused in print — 0/6/8, 1/7, 3/5/8, 5/6 — are the single most common cause of a silently wrong card number. If any digit in the numerator could plausibly be one of a confusable pair, or is small/blurred/glared, you MUST report confidence <= 0.6 for card_number and add a warning naming the ambiguous digit(s) — do not report high confidence on a guess. A wrong card number causes a downstream product-match failure that looks just like a legitimate no-match, so hiding uncertainty behind a high confidence score is worse than flagging it. This field is independently re-verified regardless of the confidence you report, so report your GENUINE confidence rather than inflating it. grade is ONLY the numeric grade as a STRING (e.g. "10", "9.5"). grade_label is the grader's DESIGNATION/TIER printed with it — e.g. CGC "PRISTINE" or "GEM MINT", PSA "GEM MT", BGS "PRISTINE"/"BLACK LABEL". From a label reading "PRISTINE 10", grade="10" and grade_label="PRISTINE". NEVER drop the designation or fold it into grade. rarity is the printed rarity (e.g. "Mega Attack Rare"). finish is the print treatment (e.g. "Holo", "Reverse Holo", "Non-Holo"). variation is the combined descriptor when the card shows one (e.g. "Mega Attack Rare - Holo"). COMPATIBLE READINGS ARE NOT CONFLICTS. A numeric grade "10" alongside a label "PRISTINE" is grade="10", grade_label="PRISTINE" — never report that as a grade conflict. A rarity "Mega Attack Rare" alongside a finish "Holo" may combine into variation "Mega Attack Rare - Holo" — never report that as a variation conflict. Only a genuine front-vs-back or label-vs-card DISAGREEMENT on the same field is a conflict. If the label and the visible card disagree, set label_matches_card=false and add a warning. Flag any unreadable field instead of guessing.`;
var VERIFY_CARD_NUMBER_SYSTEM_PROMPT = 'You are independently re-verifying ONE specific field on a graded trading-card slab label: the card_number (numerator/denominator, e.g. "016/064"). Treat this as a fresh, independent examination — you have no memory of any prior reading, and you must not anchor on what a first pass might have guessed. You return ONLY strict JSON, no prose.';
var VERIFY_CARD_NUMBER_INSTRUCTION = 'Look ONLY at the card_number printed on the slab label. Read every digit individually. Digit pairs that are frequently confused in print — 0/6/8, 1/7, 3/5/8, 5/6 — are the most common source of a wrong reading; scrutinize each digit against these confusable pairs before deciding. Return ONLY this exact JSON shape: { "card_number": { "value": <string|null>, "confidence": <0..1>, "readable": <bool> } }. If any digit is genuinely ambiguous or the text is too small/blurred/glared to be certain, set readable=false and value=null — never guess the closest-looking digit.';
var VERIFY_CERTIFICATION_SYSTEM_PROMPT = "You are independently re-verifying ONE field on a graded-card label: the certification_number. This is a fresh examination. You are not shown and must not infer any earlier prediction. Return only schema-conforming output.";
var VERIFY_CERTIFICATION_INSTRUCTION = "Look ONLY at the certification_number printed on the grading label. Read each character independently and preserve leading zeros. Return the exact certification_number schema. If glare, blur, size, or a confusable character prevents a reliable reading, set readable=false and value=null. Never reconstruct or guess a missing character.";
var VERIFY_CRITICAL_IDENTITY_SYSTEM_PROMPT = "You are independently rereading critical identity and artwork evidence on a graded-card slab. This is a fresh examination. You are not shown any earlier transcription or marketplace candidate. Return only schema-conforming output and never infer unreadable text.";
var VERIFY_CRITICAL_IDENTITY_INSTRUCTION = "Independently reread the critical identity fields card_name, grader, grade, language, and major variation. Also describe only directly visible artwork evidence: character, composition, border, set symbol, collector number, rarity marking, promo marking, and error/variation markings. If evidence is not readable or visible, return null; never use outside product knowledge and never reconstruct a character or digit.";
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
      `Card number "${first.value}" (first-pass confidence ${Math.round(first.confidence * 100)}%) could not be independently re-verified (the verification call failed to run) — verify every digit against the physical slab before running PriceCharting.`
    );
    return;
  }
  const second = mapField(secondRaw);
  if (!second.readable) {
    warnings.push(
      `Card number "${first.value}" (first-pass confidence ${Math.round(first.confidence * 100)}%) could not be confirmed by an independent second-pass re-verification — verify every digit against the physical slab before running PriceCharting.`
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
async function reverifyCertificationNumber(deps, images, proposed, warnings) {
  const first = proposed.certification_number;
  let second;
  try {
    const text = await deps.callModel({
      system: VERIFY_CERTIFICATION_SYSTEM_PROMPT,
      instruction: VERIFY_CERTIFICATION_INSTRUCTION,
      images
    });
    const parsed = JSON.parse(stripFence(text));
    second = mapField(parsed.certification_number);
  } catch {
    warnings.push("Certification number could not be independently reread. Verify every character against the original label photograph.");
    return;
  }
  if (!second.readable) {
    warnings.push("Certification number was not clear enough for an independent reread. Verify it manually from a closer, glare-free label photograph.");
    return;
  }
  const normalize = (value) => (value ?? "").replace(/\s+/g, "").toUpperCase();
  if (normalize(first.value) === normalize(second.value)) {
    proposed.certification_number = { ...first, confidence: Math.max(first.confidence, second.confidence, 0.95) };
    return;
  }
  proposed.certification_number = { value: null, confidence: 0, source: first.source, readable: false };
  warnings.push(
    `Certification number needs review: independent readings disagree ("${first.value}" vs "${second.value}"). Do not save a verified certification number until the original photograph resolves every character.`
  );
}
function parseGradeReading(raw) {
  const s = (raw ?? "").trim();
  if (!s) return { numeric: null, designation: null };
  const m = s.match(/\d{1,2}(?:\.\d)?/);
  const n = m ? Number(m[0]) : NaN;
  const numeric = Number.isFinite(n) ? n : null;
  const lower = s.toLowerCase();
  let designation = null;
  if (/black\s*label/.test(lower)) designation = "BLACK LABEL";
  else if (lower.includes("pristine")) designation = "PRISTINE";
  else if (lower.includes("perfect")) designation = "PERFECT";
  else if (lower.includes("gem")) designation = "GEM MINT";
  return { numeric, designation };
}
function reconcileGradeReadings(first, second) {
  if (!first.readable || !second.readable) {
    return {
      grade: { value: null, confidence: 0, source: first.source, readable: false },
      grade_label_designation: null,
      warning: "grade needs review: independent readings could not both resolve the evidence."
    };
  }
  const a = parseGradeReading(first.value);
  const b = parseGradeReading(second.value);
  if (a.numeric !== null && b.numeric !== null && a.numeric === b.numeric) {
    return {
      grade: {
        value: String(a.numeric),
        // canonical numeric only: "10", "9.5" (designation stripped)
        confidence: Math.max(first.confidence, second.confidence, 0.95),
        source: first.source,
        readable: true
      },
      grade_label_designation: a.designation ?? b.designation,
      warning: null
    };
  }
  return {
    grade: { value: null, confidence: 0, source: first.source, readable: false },
    grade_label_designation: null,
    warning: `grade needs review: independent readings disagree ("${first.value}" vs "${second.value}").`
  };
}
function reconcileVariationReadings(first, second) {
  const norm = (v) => (v ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (first.readable && second.readable && norm(first.value) !== norm(second.value)) {
    return {
      variation: { ...first, confidence: Math.min(first.confidence, 0.9) },
      warning: `variation readings differ ("${first.value}" vs "${second.value}") — kept "${first.value}"; confirm against the label.`
    };
  }
  if (first.readable && second.readable) {
    return { variation: { ...first, confidence: Math.max(first.confidence, second.confidence, 0.95) }, warning: null };
  }
  return { variation: first, warning: null };
}
async function reverifyCriticalIdentity(deps, images, proposed, warnings) {
  let parsed;
  try {
    const text = await deps.callModel({
      system: VERIFY_CRITICAL_IDENTITY_SYSTEM_PROMPT,
      instruction: VERIFY_CRITICAL_IDENTITY_INSTRUCTION,
      images
    });
    parsed = JSON.parse(stripFence(text));
  } catch {
    warnings.push("Critical identity fields could not be independently reread. Review the original photograph before linking a product.");
    return;
  }
  const reread = parsed.fields ?? {};
  const critical = ["card_name", "grader", "grade", "language", "variation"];
  const normalize = (value) => (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const key of critical) {
    const first = proposed[key];
    const second = mapField(reread[key]);
    if (!first.readable && !second.readable) continue;
    if (key === "grade") {
      const rec = reconcileGradeReadings(first, second);
      proposed.grade = rec.grade;
      if (rec.warning) warnings.push(rec.warning);
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
        `${key} needs review: independent readings ${!first.readable || !second.readable ? "could not both resolve the evidence" : `disagree ("${first.value}" vs "${second.value}")`}.`
      );
      continue;
    }
    proposed[key] = { ...first, confidence: Math.max(first.confidence, second.confidence, 0.95) };
  }
}
function applyIdentityReconciliation(proposed) {
  const reconciled = reconcileIdentity({
    grade: proposed.grade.value,
    grade_label: proposed.grade_label.value,
    rarity: proposed.rarity.value,
    finish: proposed.finish.value,
    variation: proposed.variation.value
  });
  const sourceConfidence = Math.max(
    proposed.rarity.confidence,
    proposed.finish.confidence,
    proposed.variation.confidence,
    proposed.grade.confidence,
    proposed.grade_label.confidence
  );
  const fold = (key) => {
    const next = reconciled[key];
    const current = proposed[key];
    if (next.value === "") return;
    if (next.value === current.value) return;
    proposed[key] = {
      value: next.value,
      // A derived value inherits the confidence of its source evidence; a value
      // merely split/canonicalized keeps at least its own confidence.
      confidence: next.derived ? Math.min(sourceConfidence, current.readable ? current.confidence || sourceConfidence : sourceConfidence) : Math.max(current.confidence, sourceConfidence),
      source: current.readable ? current.source : "label",
      readable: true
    };
  };
  ["grade", "grade_label", "rarity", "finish", "variation"].forEach(fold);
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
  for (const variant of input.variants ?? []) {
    if (!variant?.image_base64 || !ALLOWED_MIME.has(variant.mime)) continue;
    images.push({ label: variant.label, image: { base64: variant.image_base64, mime: variant.mime } });
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
  if (proposed.card_number.readable) {
    await reverifyCardNumber(deps, images, proposed, warnings);
  }
  if (proposed.certification_number.readable) {
    await reverifyCertificationNumber(deps, images, proposed, warnings);
  }
  if (input.strict_multi_pass) {
    await reverifyCriticalIdentity(deps, images, proposed, warnings);
  }
  applyIdentityReconciliation(proposed);
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
  analyzeSlabImages,
  reconcileGradeReadings,
  reconcileVariationReadings
};
