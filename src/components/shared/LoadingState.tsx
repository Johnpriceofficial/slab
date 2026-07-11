import { Loader2 } from "lucide-react";

export function LoadingState({ message = "Loading…" }: { message?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" />
      <span>{message}</span>
    </div>
  );
}
