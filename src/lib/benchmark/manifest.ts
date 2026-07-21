/**
 * Dataset manifest parsing (CSV or JSON) and structural validation. Pure: takes
 * the manifest TEXT, returns typed samples + errors. File-existence checks are
 * injected (fileExists) so this stays free of node/fs and remains unit testable.
 */

import type { BenchmarkSample } from "./types";

export interface ManifestParseResult {
  samples: BenchmarkSample[];
  errors: string[];
}

// Columns that must be present AND non-empty. grade_label, certification_number,
// rarity, finish, and variation are intentionally NOT here: a real slab may
// legitimately lack a designation, a cert, or a variation, and comparison treats
// an absent ground truth as "not evaluable" rather than a failure.
//
// grader/grade are NOT required either: a RAW (ungraded) card genuinely has
// neither, and the dataset intentionally mixes raw and slabbed items. A blank
// grader/grade scores as not-evaluable (never wrong). The labeling guide instructs
// that SLAB rows must still fill them — that is a labeling convention, not a
// parser rule, because the manifest has no per-row raw/slab discriminator.
const REQUIRED_COLUMNS = [
  "sample_id",
  "front_image_path",
  "card_name",
  "set_name",
  "card_number",
  "language",
] as const;

const OPTIONAL_STRING_COLUMNS = [
  "back_image_path",
  "grader",
  "grade",
  "label_color",
  "lighting_condition",
  "orientation",
  "notes",
  "glare",
  "blur",
  "crop_quality",
  "pricecharting_product_id",
] as const;

/** Minimal RFC-4180-ish CSV parser: quoted fields, escaped quotes, CRLF/LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const push = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    push();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      push();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      endRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Flush a trailing field/row unless the text ended on a clean newline.
  if (field !== "" || row.length > 0) endRow();
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

function toSample(record: Record<string, string>): BenchmarkSample {
  const get = (k: string) => (record[k] ?? "").trim();
  const optional = (k: string) => {
    const v = get(k);
    return v === "" ? undefined : v;
  };
  const backPath = get("back_image_path");
  return {
    sample_id: get("sample_id"),
    front_image_path: get("front_image_path"),
    back_image_path: backPath === "" ? null : backPath,
    grader: get("grader"),
    grade: get("grade"),
    grade_label: get("grade_label"),
    certification_number: get("certification_number"),
    card_name: get("card_name"),
    set_name: get("set_name"),
    card_number: get("card_number"),
    language: get("language"),
    rarity: get("rarity"),
    finish: get("finish"),
    variation: get("variation"),
    label_color: get("label_color"),
    lighting_condition: get("lighting_condition"),
    orientation: get("orientation"),
    notes: get("notes"),
    glare: optional("glare"),
    blur: optional("blur"),
    crop_quality: optional("crop_quality"),
    pricecharting_product_id: optional("pricecharting_product_id"),
  };
}

/** Parse a manifest from CSV or JSON text into typed samples + structural errors. */
export function parseManifest(text: string, format: "csv" | "json"): ManifestParseResult {
  const errors: string[] = [];
  let records: Record<string, string>[];

  if (format === "json") {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { samples: [], errors: [`Invalid JSON manifest: ${e instanceof Error ? e.message : "parse error"}`] };
    }
    const arr = Array.isArray(data) ? data : (data as { samples?: unknown }).samples;
    if (!Array.isArray(arr)) {
      return { samples: [], errors: ["JSON manifest must be an array of samples (or { samples: [...] })."] };
    }
    records = arr.map((row) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
        out[k] = v === null || v === undefined ? "" : String(v);
      }
      return out;
    });
  } else {
    const rows = parseCsv(text);
    if (rows.length === 0) return { samples: [], errors: ["CSV manifest is empty."] };
    const header = rows[0].map((h) => h.trim());
    const missingCols = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
    if (missingCols.length > 0) {
      return { samples: [], errors: [`CSV manifest is missing required columns: ${missingCols.join(", ")}.`] };
    }
    records = rows.slice(1).map((cols) => {
      const rec: Record<string, string> = {};
      header.forEach((h, idx) => (rec[h] = cols[idx] ?? ""));
      return rec;
    });
  }

  const samples: BenchmarkSample[] = [];
  const seen = new Set<string>();
  records.forEach((record, index) => {
    const missing = REQUIRED_COLUMNS.filter((c) => (record[c] ?? "").trim() === "");
    if (missing.length > 0) {
      errors.push(`Row ${index + 1}: missing required field(s): ${missing.join(", ")}.`);
      return;
    }
    // Referenced but unused optional columns are tolerated silently.
    void OPTIONAL_STRING_COLUMNS;
    const sample = toSample(record);
    if (seen.has(sample.sample_id)) {
      errors.push(`Row ${index + 1}: duplicate sample_id "${sample.sample_id}".`);
      return;
    }
    seen.add(sample.sample_id);
    samples.push(sample);
  });

  return { samples, errors };
}

/**
 * Validate that every referenced image file exists. `fileExists` is injected so
 * this remains pure and testable; the CLI passes an fs-backed implementation.
 */
export function validateImages(
  samples: BenchmarkSample[],
  fileExists: (path: string) => boolean,
): string[] {
  const errors: string[] = [];
  for (const s of samples) {
    if (!s.front_image_path || !fileExists(s.front_image_path)) {
      errors.push(`Sample "${s.sample_id}": front image not found at "${s.front_image_path}".`);
    }
    if (s.back_image_path && !fileExists(s.back_image_path)) {
      errors.push(`Sample "${s.sample_id}": back image not found at "${s.back_image_path}".`);
    }
  }
  return errors;
}
