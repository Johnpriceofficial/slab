/**
 * Normalizes an arbitrary user-picked image file into a browser-safe,
 * web-standard format (JPEG/PNG/WEBP) before it enters the rest of the
 * pipeline (preview <img>, upload, and the vision model in analyze-slab).
 *
 * Why this exists: browsers other than Safari cannot decode HEIC/HEIF at all
 * (no <img> preview, no canvas access), and vision models generally reject
 * or mishandle non-web-standard formats. Rather than restricting the picker
 * to a fixed allow-list and rejecting real photos (most iPhone camera rolls
 * default to HEIC), we accept ANY image the OS file picker offers and
 * convert it client-side:
 *   - HEIC/HEIF -> decoded via heic2any (a pure-JS HEIC decoder; no native
 *     browser support required) -> JPEG.
 *   - Anything else the browser's own <img> decoder can read (GIF, BMP,
 *     AVIF, ICO, SVG rasterized, etc.) -> re-encoded via canvas -> JPEG.
 *   - Already-web-safe JPEG/PNG/WEBP -> passed through unchanged (no lossy
 *     re-encode of a file that's already fine).
 *
 * Formats no browser can decode at all (e.g. raw TIFF) fail at the canvas
 * re-encode step and surface a clear, actionable error rather than silently
 * producing a broken preview or upload.
 */

import { MAX_IMAGE_BYTES } from "./constants";
import { extensionFor } from "./format";

const WEB_SAFE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const HEIC_EXTENSIONS = new Set(["heic", "heif"]);
const HEIC_MIME_TYPES = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);
/**
 * Extensions we recognize as "plausibly an image" even when the browser
 * reports an empty/generic MIME type (common for HEIC and some RAW-adjacent
 * formats picked from a phone's camera roll). Used only to decide whether to
 * attempt conversion at all, not to skip conversion.
 */
const IMAGE_EXTENSION_HINTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "heic",
  "heif",
  "gif",
  "bmp",
  "avif",
  "ico",
  "tif",
  "tiff",
  "svg",
]);

export interface ImageNormalizeDeps {
  /** Decodes a HEIC/HEIF Blob into a JPEG Blob. */
  decodeHeic: (blob: Blob) => Promise<Blob>;
  /** Re-encodes any browser-decodable image Blob into a JPEG Blob via canvas. */
  reencodeViaCanvas: (blob: Blob) => Promise<Blob>;
}

async function defaultDecodeHeic(blob: Blob): Promise<Blob> {
  const heic2any = (await import("heic2any")).default;
  const result = await heic2any({ blob, toType: "image/jpeg", quality: 0.92 });
  const out = Array.isArray(result) ? result[0] : result;
  return out as Blob;
}

async function defaultReencodeViaCanvas(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Browser could not decode this image format."));
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable.");
    ctx.drawImage(img, 0, 0);
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!out) throw new Error("Failed to re-encode image.");
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const defaultImageNormalizeDeps: ImageNormalizeDeps = {
  decodeHeic: defaultDecodeHeic,
  reencodeViaCanvas: defaultReencodeViaCanvas,
};

export interface NormalizeResult {
  file: File | null;
  error: string | null;
}

/** Replace (or add) the extension in a filename, e.g. "photo.HEIC" -> "photo.jpg". */
function withJpegExtension(name: string): string {
  const base = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  return `${base || "image"}.jpg`;
}

/**
 * Accepts ANY file the OS image picker returned and normalizes it into a
 * web-safe image File. Returns { file: null, error } when the file is too
 * large, doesn't look like an image at all, or the browser genuinely cannot
 * decode its format (e.g. raw TIFF).
 */
export async function normalizeImageFile(file: File, deps: ImageNormalizeDeps = defaultImageNormalizeDeps): Promise<NormalizeResult> {
  if (file.size > MAX_IMAGE_BYTES) {
    return { file: null, error: `Image is too large (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB).` };
  }

  const ext = extensionFor(file.name, file.type);
  const looksLikeImage = file.type.startsWith("image/") || IMAGE_EXTENSION_HINTS.has(ext);
  if (!looksLikeImage) {
    return { file: null, error: "That doesn't look like an image file. Please choose a photo." };
  }

  const isHeic = HEIC_EXTENSIONS.has(ext) || HEIC_MIME_TYPES.has(file.type);

  // Already web-safe and not HEIC (some cameras mislabel HEIC with a .jpg
  // extension in rare cases, so the extension/MIME HEIC check above takes
  // priority over this fast path).
  if (!isHeic && WEB_SAFE_TYPES.has(file.type)) {
    return { file, error: null };
  }

  try {
    const jpegBlob = isHeic ? await deps.decodeHeic(file) : await deps.reencodeViaCanvas(file);
    const normalized = new File([jpegBlob], withJpegExtension(file.name), { type: "image/jpeg" });
    return { file: normalized, error: null };
  } catch {
    return {
      file: null,
      error: "Could not read this image format. Try a JPEG, PNG, WEBP, or HEIC photo instead.",
    };
  }
}
