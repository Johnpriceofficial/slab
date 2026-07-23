import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Upload, RefreshCw, X, ImageIcon, Loader2 } from "lucide-react";
import { createSlabImageState, releaseSlabImageState, type SlabImageState } from "@/lib/slabs/image-state";

export type { SlabImageState };

interface ImageUploaderProps {
  label: string;
  side: "front" | "back";
  image: SlabImageState | null;
  onChange: (image: SlabImageState | null) => void;
  requirement?: "required" | "optional";
}

export function ImageUploader({ label, side, image, onChange, requirement = side === "front" ? "required" : "optional" }: ImageUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [converting, setConverting] = useState(false);
  const pick = () => inputRef.current?.click();

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setConverting(true);
    const { image: next, error } = await createSlabImageState(file);
    setConverting(false);
    if (error || !next) {
      onChange(null);
      import("sonner").then(({ toast }) => toast.error(error ?? "Could not use this image."));
      return;
    }
    releaseSlabImageState(image);
    onChange(next);
  };

  const clear = () => {
    releaseSlabImageState(image);
    onChange(null);
  };

  return (
    <div className="space-y-2">
      <Label className="font-medium">
        {label} <span className="text-muted-foreground">({requirement === "required" ? "Required" : "Optional"})</span>
      </Label>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleFile} aria-label={`Upload ${requirement} ${side} image`} />
      {converting ? (
        <div className="flex h-48 w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <span className="text-sm">Converting image…</span>
        </div>
      ) : image ? (
        <div className="rounded-lg border bg-muted/30 p-2">
          <img src={image.previewUrl} alt={`${side} of slab`} className="mx-auto max-h-64 w-auto rounded object-contain" />
          <div className="mt-2 flex justify-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={pick}><RefreshCw className="mr-1 h-4 w-4" /> Replace</Button>
            <Button type="button" variant="ghost" size="sm" onClick={clear}><X className="mr-1 h-4 w-4" /> Clear</Button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={pick} className="flex h-48 w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed text-muted-foreground transition-colors hover:border-primary hover:text-primary">
          <ImageIcon className="h-8 w-8" />
          <span className="text-sm">{side === "back" ? "Add Back Image" : "Click to upload the front image"}</span>
          <span className="flex items-center gap-1 text-xs"><Upload className="h-3 w-3" /> Any photo — HEIC, JPEG, PNG, WEBP, and more</span>
          {side === "back" && <span className="px-3 text-center text-xs">Optional: additional visual and archival documentation only.</span>}
        </button>
      )}
    </div>
  );
}
