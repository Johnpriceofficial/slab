import { supabase } from "@/integrations/supabase/client";

export interface CardExtraction {
  card_name: string;
  set_name: string;
  card_number: string;
  rarity: string;
  condition_issues: { whitening: string; scratches: string; centering_notes: string; other: string };
  confidence: number;
}

export interface DuplicateCard {
  id: string;
  card_name: string;
  set_name: string;
  card_number: string;
  created_at: string;
}

export interface ScanCardResponse {
  status: "added" | "needs_review" | "possible_duplicate" | "skipped" | "error";
  scan_id?: string;
  extraction?: CardExtraction;
  duplicates?: DuplicateCard[];
  card?: { id: string } & Partial<CardExtraction>;
  error_code?: string;
  message?: string;
}

export interface ReviewItem {
  id: string;
  scan_id: string;
  review_reason: "low_confidence" | "possible_duplicate";
  proposed_data: CardExtraction;
  created_at: string;
  confidence: number;
  thumbnail_url: string | null;
}

async function invoke(body: FormData | Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Your session expired. Sign in again.");

  // Production exposes the requested same-origin /api/scan-card route through a
  // Vercel rewrite. Local Vite uses Supabase Functions directly.
  if (typeof window !== "undefined" && !/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) {
    const response = await fetch("/api/scan-card", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? ""),
        ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      },
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({ message: "Scanner returned an unreadable response." }));
    if (!response.ok) throw new Error(String(payload.message ?? "Card scan failed."));
    return payload as Record<string, unknown>;
  }

  const { data, error } = await supabase.functions.invoke("scan-card", { body });
  if (error) throw new Error(error.message || "Card scan failed.");
  return data as Record<string, unknown>;
}

export async function scanCard(image: Blob): Promise<ScanCardResponse> {
  const form = new FormData();
  form.append("image", image, "camera-scan.jpg");
  return await invoke(form) as unknown as ScanCardResponse;
}

export async function resolveScan(input: {
  action: "confirm" | "skip";
  scan_id: string;
  card_name?: string;
  set_name?: string;
  card_number?: string;
  rarity?: string;
  add_anyway?: boolean;
}): Promise<ScanCardResponse> {
  return await invoke(input) as unknown as ScanCardResponse;
}

export async function fetchScanReviews(): Promise<ReviewItem[]> {
  const data = await invoke({ action: "list_reviews" });
  return Array.isArray(data.reviews) ? data.reviews as ReviewItem[] : [];
}
