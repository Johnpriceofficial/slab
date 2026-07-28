/**
 * Server-side image-input validation for analyze-slab.
 *
 * Runs BEFORE any AI-provider request, in both runtimes (Node via vitest and
 * Deno once bundled). Frontend validation is a UX nicety, never a security
 * control: every byte limit, MIME rule and base64 check is enforced here on
 * the server regardless of what the client claims.
 *
 * Pure module: no I/O, no runtime-specific APIs beyond the web-standard
 * `atob`, and no throwing — callers receive a typed error or null.
 */

export interface ImageValidationLimits {
  /** Maximum decoded bytes for any single image. */
  maxImageBytes: number;
  /** Maximum decoded bytes across every image in one request. */
  maxAggregateBytes: number;
  /** Maximum number of client-supplied variant images. */
  maxVariants: number;
}

/**
 * Defaults: per-image cap matches the slab-images bucket limit (15 MB);
 * the aggregate cap bounds one whole analysis request; variants cover the
 * deterministic client derivatives with generous headroom.
 */
export const DEFAULT_IMAGE_LIMITS: ImageValidationLimits = {
  maxImageBytes: 15_728_640,
  maxAggregateBytes: 41_943_040,
  maxVariants: 8,
};

export type ImageValidationCode =
  | "MISSING_IMAGE"
  | "UNSUPPORTED_IMAGE"
  | "INVALID_BASE64"
  | "EMPTY_IMAGE"
  | "IMAGE_TOO_LARGE"
  | "AGGREGATE_IMAGE_LIMIT"
  | "TOO_MANY_VARIANTS";

export interface ImageValidationError {
  code: ImageValidationCode;
  statusCode: number;
  message: string;
}

interface CandidateImage {
  label: string;
  base64: string;
  mime: string;
}

export interface AnalyzeImageInputLike {
  front_image_base64?: string;
  front_mime?: string;
  back_image_base64?: string;
  back_mime?: string;
  variants?: Array<{ label: string; image_base64: string; mime: string }>;
}

const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function fail(code: ImageValidationCode, statusCode: number, message: string): ImageValidationError {
  return { code, statusCode, message };
}

/** Decoded byte length of a syntactically valid base64 string. */
function decodedLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/** First decoded bytes (up to 12) without materializing the whole image. */
function leadingBytes(base64: string): Uint8Array {
  const prefix = base64.slice(0, 16); // 16 base64 chars -> 12 bytes
  const binary = atob(prefix);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Signature check where the format has a stable magic prefix. HEIC/HEIF use an
 * ISO-BMFF `ftyp` box at offset 4. Returns false only on a definite mismatch.
 */
function contentMatchesMime(bytes: Uint8Array, mime: string): boolean {
  if (bytes.length < 12) return false;
  switch (mime) {
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return (
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
      );
    case "image/webp":
      return (
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
      );
    case "image/heic":
    case "image/heif":
      return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
    default:
      return false;
  }
}

function validateOne(
  candidate: CandidateImage,
  limits: ImageValidationLimits,
): ImageValidationError | { bytes: number } {
  if (!ALLOWED_IMAGE_MIME.has(candidate.mime)) {
    return fail("UNSUPPORTED_IMAGE", 400, `Unsupported ${candidate.label} image type: ${candidate.mime}.`);
  }
  const base64 = candidate.base64;
  if (base64.length === 0) {
    return fail("EMPTY_IMAGE", 400, `The ${candidate.label} image is empty.`);
  }
  if (base64.length % 4 !== 0 || !BASE64_RE.test(base64)) {
    return fail("INVALID_BASE64", 400, `The ${candidate.label} image is not valid base64.`);
  }
  const bytes = decodedLength(base64);
  if (bytes <= 0) {
    return fail("EMPTY_IMAGE", 400, `The ${candidate.label} image decoded to zero bytes.`);
  }
  if (bytes > limits.maxImageBytes) {
    return fail(
      "IMAGE_TOO_LARGE",
      413,
      `The ${candidate.label} image exceeds the ${limits.maxImageBytes}-byte limit.`,
    );
  }
  let leading: Uint8Array;
  try {
    leading = leadingBytes(base64);
  } catch {
    return fail("INVALID_BASE64", 400, `The ${candidate.label} image is not valid base64.`);
  }
  if (!contentMatchesMime(leading, candidate.mime)) {
    return fail(
      "UNSUPPORTED_IMAGE",
      400,
      `The ${candidate.label} image content does not match its declared type (${candidate.mime}).`,
    );
  }
  return { bytes };
}

/**
 * Validates the full analyze-slab image payload. Returns null when every
 * image the analysis would consume is safe, or the first typed error.
 */
export function validateAnalyzeImageInput(
  input: AnalyzeImageInputLike,
  limits: ImageValidationLimits = DEFAULT_IMAGE_LIMITS,
): ImageValidationError | null {
  if (!input.front_image_base64 || !input.front_mime) {
    return fail("MISSING_IMAGE", 400, "A front image is required to analyze a slab.");
  }

  const variants = input.variants ?? [];
  if (variants.length > limits.maxVariants) {
    return fail(
      "TOO_MANY_VARIANTS",
      400,
      `At most ${limits.maxVariants} image variants are accepted per request.`,
    );
  }

  const candidates: CandidateImage[] = [
    { label: "front", base64: input.front_image_base64, mime: input.front_mime },
  ];
  if (input.back_image_base64 && input.back_mime) {
    candidates.push({ label: "back", base64: input.back_image_base64, mime: input.back_mime });
  }
  for (const [index, variant] of variants.entries()) {
    // Only variants the analysis would actually forward are validated; the
    // handler skips entries with no payload or a disallowed MIME type.
    if (!variant?.image_base64 || !ALLOWED_IMAGE_MIME.has(variant.mime)) continue;
    candidates.push({
      label: variant.label || `variant_${index + 1}`,
      base64: variant.image_base64,
      mime: variant.mime,
    });
  }

  let aggregate = 0;
  for (const candidate of candidates) {
    const result = validateOne(candidate, limits);
    if ("code" in result) return result;
    aggregate += result.bytes;
    if (aggregate > limits.maxAggregateBytes) {
      return fail(
        "AGGREGATE_IMAGE_LIMIT",
        413,
        `The combined decoded image payload exceeds the ${limits.maxAggregateBytes}-byte limit.`,
      );
    }
  }

  return null;
}
