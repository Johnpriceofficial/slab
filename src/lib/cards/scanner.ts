export interface RectLike { left: number; top: number; width: number; height: number }
export interface SourceCrop { sx: number; sy: number; sw: number; sh: number }

/** Maps the visible guide rectangle through an object-cover video element back
 * to intrinsic video pixels, so the JPEG contains exactly the aligned card. */
export function computeSourceCrop(
  videoWidth: number,
  videoHeight: number,
  frame: RectLike,
  guide: RectLike,
): SourceCrop {
  if (videoWidth <= 0 || videoHeight <= 0 || frame.width <= 0 || frame.height <= 0) {
    throw new Error("Camera frame is not ready.");
  }
  const scale = Math.max(frame.width / videoWidth, frame.height / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  const offsetX = (frame.width - renderedWidth) / 2;
  const offsetY = (frame.height - renderedHeight) / 2;
  const localLeft = guide.left - frame.left;
  const localTop = guide.top - frame.top;
  const sx = Math.max(0, Math.min(videoWidth - 1, (localLeft - offsetX) / scale));
  const sy = Math.max(0, Math.min(videoHeight - 1, (localTop - offsetY) / scale));
  const sw = Math.max(1, Math.min(videoWidth - sx, guide.width / scale));
  const sh = Math.max(1, Math.min(videoHeight - sy, guide.height / scale));
  return { sx, sy, sw, sh };
}

export function outputSize(crop: SourceCrop, maxLongEdge = 1800): { width: number; height: number } {
  const long = Math.max(crop.sw, crop.sh);
  const scale = Math.min(1, maxLongEdge / long);
  return { width: Math.max(1, Math.round(crop.sw * scale)), height: Math.max(1, Math.round(crop.sh * scale)) };
}
