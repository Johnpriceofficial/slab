import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Upload, RefreshCw, X, ImageIcon } from "lucide-react";
import { ACCEPTED_IMAGE_EXT, ACCEPTED_IMAGE_MIME, MAX_IMAGE_BYTES } from "@/lib/slabs/constants";
import { extensionFor } from "@/lib/slabs/format";

export interface SlabImageState {
  file: File;
  previewUrl: string;
  ext: string;
}

interface ImageUploaderProps {
  label: string;
  side: "front" | "back";
  image: SlabImageState | null;
  onChange: (image: SlabImageState | null) => void;
}

/** Validate a picked file; returns an error string or null. */
export function validateImageFile(file: File): string | null {
  const ext = extensionFor(file.name, file.type);
  const mimeOk = !file.type || ACCEPTED_IMAGE_MIME.includes(file.type);
  const extOk = ACCEPTED_IMAGE_EXT.includes(ext);
  if (!mimeOk && !extOk) return "Unsupported image type. Use JPEG, PNG, WEBP, or HEIC.";
  if (file.size > MAX_IMAGE_BYTES) return `Image is too large (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB).`;
  return null;
}

export function ImageUploader({ label, side, image, onChange }: ImageUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = () => inputRef.current?.click();

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    const err = validateImageFile(file);
    if (err) {
      onChange(null);
      // Surface via a tiny inline alert by throwing to caller? Use window alert-free:
      // We attach the error to the element via data attribute-free approach:
      import("sonner").then(({ toast }) => toast.error(err));
      return;
    }
    if (image?.previewUrl) URL.revokeObjectURL(image.previewUrl);
    onChange({ file, previewUrl: URL.createObjectURL(file), ext: extensionFor(file.name, file.type) });
  };

  const clear = () => {
    if (image?.previewUrl) URL.revokeObjectURL(image.previewUrl);
    onChange(null);
  };

  return (
    <div className="space-y-2">
      <Label className="font-medium">
        {label} <span className="text-muted-foreground">({side})</span>
      </Label>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_IMAGE_MIME.join(",")}
        className="hidden"
        onChange={handleFile}
        aria-label={`Upload ${side} image`}
      />
      {image ? (
        <div className="rounded-lg border bg-muted/30 p-2">
          <img
            src={image.previewUrl}
            alt={`${side} of slab`}
            className="mx-auto max-h-64 w-auto rounded object-contain"
          />
          <div className="mt-2 flex justify-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={pick}>
              <RefreshCw className="mr-1 h-4 w-4" /> Replace
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={clear}>
              <X className="mr-1 h-4 w-4" /> Clear
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={pick}
          className="flex h-48 w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed text-muted-foreground transition-colors hover:border-primary hover:text-primary"
        >
          <ImageIcon className="h-8 w-8" />
          <span className="text-sm">Click to upload the {side} image</span>
          <span className="flex items-center gap-1 text-xs">
            <Upload className="h-3 w-3" /> JPEG · PNG · WEBP · HEIC
          </span>
        </button>
      )}
    </div>
  );
}
