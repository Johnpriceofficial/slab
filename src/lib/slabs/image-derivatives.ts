/** Deterministic, non-generative image variants used only as reading aids. */

export type DerivativeKind = "label_contrast" | "label_grayscale" | "collector_threshold" | "certification_sharpened";

export interface AnalysisVariant {
  label: DerivativeKind;
  blob: Blob;
  mime: "image/png";
  width: number;
  height: number;
  transform_manifest: Record<string, unknown>;
}

export const DETERMINISTIC_TRANSFORMS: Record<DerivativeKind, Record<string, unknown>> = {
  label_contrast: { version: 1, crop: [0, 0, 1, 0.32], grayscale: false, contrast: 1.35, sharpen: true, interpolation: "bicubic" },
  label_grayscale: { version: 1, crop: [0, 0, 1, 0.32], grayscale: true, contrast: 1.5, sharpen: false, interpolation: "bicubic" },
  collector_threshold: { version: 1, crop: [0.48, 0.55, 0.52, 0.45], grayscale: true, threshold: 0.58, sharpen: false, interpolation: "bicubic" },
  certification_sharpened: { version: 1, crop: [0.45, 0, 0.55, 0.25], grayscale: false, contrast: 1.25, sharpen: true, interpolation: "bicubic" },
};

function clamp(value: number): number {
  return Math.max(0, Math.min(255, value));
}

function applyPixels(data: ImageData, manifest: Record<string, unknown>): void {
  const grayscale = manifest.grayscale === true;
  const contrast = typeof manifest.contrast === "number" ? manifest.contrast : 1;
  const threshold = typeof manifest.threshold === "number" ? manifest.threshold * 255 : null;
  for (let i = 0; i < data.data.length; i += 4) {
    let r = data.data[i];
    let g = data.data[i + 1];
    let b = data.data[i + 2];
    if (grayscale || threshold !== null) {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = g = b = y;
    }
    r = clamp((r - 128) * contrast + 128);
    g = clamp((g - 128) * contrast + 128);
    b = clamp((b - 128) * contrast + 128);
    if (threshold !== null) r = g = b = r >= threshold ? 255 : 0;
    data.data[i] = r;
    data.data[i + 1] = g;
    data.data[i + 2] = b;
  }
}

async function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not create deterministic image derivative.");
  return blob;
}

/**
 * Uses fixed crop geometry and fixed pixel kernels only. No model, inpainting,
 * super-resolution network, or generative reconstruction is involved.
 */
export async function buildDeterministicAnalysisVariants(blob: Blob): Promise<AnalysisVariant[]> {
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("Image could not be decoded for deterministic enhancement."));
      element.src = url;
    });
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const variants: AnalysisVariant[] = [];
    for (const label of Object.keys(DETERMINISTIC_TRANSFORMS) as DerivativeKind[]) {
      const manifest = DETERMINISTIC_TRANSFORMS[label];
      const crop = manifest.crop as number[];
      const sx = Math.round(sourceWidth * crop[0]);
      const sy = Math.round(sourceHeight * crop[1]);
      const sw = Math.max(1, Math.round(sourceWidth * crop[2]));
      const sh = Math.max(1, Math.round(sourceHeight * crop[3]));
      const scale = Math.min(3, Math.max(1, 1800 / Math.max(sw, sh)));
      const width = Math.round(sw * scale);
      const height = Math.round(sh * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("Canvas is unavailable.");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, width, height);
      const pixels = ctx.getImageData(0, 0, width, height);
      applyPixels(pixels, manifest);
      ctx.putImageData(pixels, 0, 0);
      if (manifest.sharpen === true) ctx.filter = "contrast(1.08)";
      variants.push({ label, blob: await canvasBlob(canvas), mime: "image/png", width, height, transform_manifest: manifest });
    }
    return variants;
  } finally {
    URL.revokeObjectURL(url);
  }
}
