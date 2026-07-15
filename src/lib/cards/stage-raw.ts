/**
 * Create a raw card from a universal-scanner capture WITHOUT a second model call.
 *
 * The universal analysis (analyze-slab) already produced the normalized card
 * identity. Rather than re-running the raw scanner's own model, this uploads the
 * captured front (and optional back) to the private card-scans bucket and calls
 * `stage_raw_card`, which creates the card_scans + cards rows from that
 * extraction. The R-code is assigned by the raw-card trigger. One AI call total.
 */

import { supabase } from "@/integrations/supabase/client";
import type { AnalyzeResult } from "@/server/analyze-slab/handler";
import type { InventoryCard } from "./api";

const BUCKET = "card-scans";

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function readField(analysis: AnalyzeResult, key: keyof AnalyzeResult["proposed"]): string | null {
  const f = analysis.proposed[key];
  return f?.readable && f.value ? f.value : null;
}

/** Fields the raw-card record requires to be created. */
export function rawIdentityGaps(analysis: AnalyzeResult): string[] {
  const gaps: string[] = [];
  if (!readField(analysis, "card_name")) gaps.push("card name");
  if (!readField(analysis, "set")) gaps.push("set");
  if (!readField(analysis, "card_number")) gaps.push("card number");
  return gaps;
}

export interface RawStageImages {
  /** The normalized front File (JPEG). */
  front: File;
  /** Optional back File (JPEG). */
  back?: File | null;
}

/**
 * Stage a raw card from the analysis + captured images. Returns the created
 * card. Throws if the front image can't upload or a required identity field is
 * missing (the scanner resolves that with a back capture or a reanalysis first).
 */
export async function stageRawCard(analysis: AnalyzeResult, images: RawStageImages): Promise<InventoryCard> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const uid = userData?.user?.id;
  if (userError || !uid) throw new Error("Your session expired. Sign in again.");

  const base = `${uid}/${crypto.randomUUID()}`;
  const frontPath = `${base}.jpg`;
  const backPath = images.back ? `${base}-back.jpg` : null;

  const up = await supabase.storage.from(BUCKET).upload(frontPath, images.front, { upsert: false, contentType: "image/jpeg" });
  if (up.error) throw new Error(`The front image could not be uploaded: ${up.error.message}`);
  if (images.back && backPath) {
    const upBack = await supabase.storage.from(BUCKET).upload(backPath, images.back, { upsert: false, contentType: "image/jpeg" });
    if (upBack.error) throw new Error(`The back image could not be uploaded: ${upBack.error.message}`);
  }

  const p = {
    front_image_path: frontPath,
    back_image_path: backPath,
    front_sha256: await sha256Hex(images.front),
    front_byte_size: images.front.size,
    confidence: analysis.overall_confidence,
    card_name: readField(analysis, "card_name"),
    set_name: readField(analysis, "set"),
    card_number: readField(analysis, "card_number"),
    rarity: readField(analysis, "rarity"),
  };

  const { data, error } = await supabase.rpc("stage_raw_card", { p });
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data[0] : data) as InventoryCard;
}
