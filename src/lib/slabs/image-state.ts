/**
 * The single conversion from "some image the user produced" into the
 * `SlabImageState` the Add a Slab screen renders, analyzes, and uploads.
 *
 * Two callers produce slab images and they must behave identically:
 *   - `ImageUploader` — a File chosen from the OS picker (manual upload).
 *   - `CardScanner`   — a JPEG Blob captured from the live camera canvas.
 *
 * Both run through `normalizeImageFile`, so a camera capture and a manual
 * upload reach `saveSlab`/`analyzeSlab` in exactly the same shape: an
 * untouched `originalFile` retained for evidence storage, plus a browser-safe
 * `file` used for preview, analysis, and the primary upload.
 */

import { extensionFor } from "./format";
import { normalizeImageFile, type ImageNormalizeDeps, defaultImageNormalizeDeps } from "./image-normalize";

export interface SlabImageState {
  /** Byte-for-byte user-selected/captured file, retained for evidence storage. */
  originalFile: File;
  /** Browser-safe deterministic decode used for preview and analysis. */
  file: File;
  previewUrl: string;
  ext: string;
}

export interface SlabImageResult {
  image: SlabImageState | null;
  error: string | null;
}

/**
 * A canvas capture is a bare Blob with no name. Give it one so the downstream
 * extension/MIME logic (`extensionFor`, original-evidence upload) has the same
 * inputs it gets from a picked File.
 */
export function asImageFile(input: Blob | File, fallbackName = "camera-capture.jpg"): File {
  if (input instanceof File) return input;
  return new File([input], fallbackName, { type: input.type || "image/jpeg" });
}

/**
 * Normalizes any Blob/File into a `SlabImageState`, minting the preview object
 * URL. Returns `{ image: null, error }` when the image is too large or the
 * browser cannot decode it — callers surface `error` and stage nothing.
 */
export async function createSlabImageState(
  input: Blob | File,
  options: { fallbackName?: string; deps?: ImageNormalizeDeps } = {},
): Promise<SlabImageResult> {
  const originalFile = asImageFile(input, options.fallbackName);
  const { file: normalized, error } = await normalizeImageFile(
    originalFile,
    options.deps ?? defaultImageNormalizeDeps,
  );
  if (error || !normalized) {
    return { image: null, error: error ?? "Could not use this image." };
  }
  return {
    image: {
      originalFile,
      file: normalized,
      previewUrl: URL.createObjectURL(normalized),
      ext: extensionFor(normalized.name, normalized.type),
    },
    error: null,
  };
}

/** Releases the preview object URL a `SlabImageState` owns. */
export function releaseSlabImageState(image: SlabImageState | null): void {
  if (image?.previewUrl) URL.revokeObjectURL(image.previewUrl);
}
