import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Upload, RefreshCw, X, ImageIcon, Loader2 } from "lucide-react";
import { extensionFor } from "@/lib/slabs/format";
import { normalizeImageFile } from "@/lib/slabs/image-normalize";

export interface SlabImageState {
  /** Byte-for-byte user-selected file, retained for evidence storage. */
  originalFile: File;
  /** Browser-safe deterministic decode used for preview and analysis. */
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

export function ImageUploader({ label, side, image, onChange }: ImageUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [converting, setConverting] = useState(false);

  const pick = () => inputRef.current?.click();

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;

    setConverting(true);
    const { file: normalized, error } = await normalizeImageFile(file);
    setConverting(false);

    if (error || !normalized) {
      onChange(null);
      import("sonner").then(({ toast }) => toast.error(error ?? "Could not use this image."));
      return;
    }

    if (image?.previewUrl) URL.revokeObjectURL(image.previewUrl);
    onChange({
      originalFile: file,
      file: normalized,
      previewUrl: URL.createObjectURL(normalized),
      ext: extensionFor(normalized.name, normalized.type),
    });
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
        accept="image/*"
        className="hidden"
        onChange={handleFile}
        aria-label={`Upload ${side} image`}
      />
      {converting ? (
        <div className="flex h-48 w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <span className="text-sm">Converting image…</span>
        </div>
      ) : image ? (
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
            <Upload className="h-3 w-3" /> Any photo — HEIC, JPEG, PNG, WEBP, and more
          </span>
        </button>
      )}
    </div>
  );
}
