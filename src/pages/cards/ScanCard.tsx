import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Camera, ChevronDown, ImagePlus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { CardScanner } from "@/components/cards/CardScanner";
import { PageHead } from "@/components/seo/PageHead";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { fetchScanReviews, resolveScan, type ReviewItem } from "@/lib/cards/api";

export default function ScanCardPage() {
  const queryClient = useQueryClient();
  const { data: reviews = [], isLoading } = useQuery({ queryKey: ["card-scan-reviews"], queryFn: fetchScanReviews });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["card-scan-reviews"] });

  return (
    <main className="mx-auto w-full max-w-6xl sm:px-4 sm:py-6">
      <PageHead title="Scan Card · GradedCardValue.com" noindex />
      <div className="px-4 py-4 sm:px-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold"><Camera className="text-primary" /> Scan Card</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Point your phone at one card, align it, and scan. Captures go straight to your private inventory—nothing is saved to your camera roll.</p>
          </div>
          <Button variant="outline" asChild><Link to="/slabs/new"><ImagePlus /> Manual photo upload</Link></Button>
        </div>
      </div>

      <CardScanner onInventoryChange={refresh} />

      <section className="px-4 py-6 sm:px-0">
        <details className="group" open={reviews.length > 0}>
          <summary className="flex cursor-pointer list-none items-center justify-between rounded-xl border bg-card px-4 py-3 font-medium shadow-sm">
            <span>Needs Review <Badge className="ml-2" variant={reviews.length ? "default" : "outline"}>{reviews.length}</Badge></span>
            <ChevronDown className="transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-3 space-y-3">
            {isLoading ? <div className="py-8 text-center"><Loader2 className="mx-auto animate-spin" /></div> : reviews.length === 0 ? (
              <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No scans need review.</p>
            ) : reviews.map((review) => <ReviewCard key={review.id} review={review} onResolved={refresh} />)}
          </div>
        </details>
      </section>
    </main>
  );
}

function ReviewCard({ review, onResolved }: { review: ReviewItem; onResolved(): void }) {
  const [form, setForm] = useState({
    card_name: review.proposed_data.card_name,
    set_name: review.proposed_data.set_name,
    card_number: review.proposed_data.card_number,
    rarity: review.proposed_data.rarity,
  });
  const [saving, setSaving] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState(review.review_reason === "possible_duplicate");

  const act = async (action: "confirm" | "skip", addAnyway = false) => {
    setSaving(true);
    try {
      const response = await resolveScan({ action, scan_id: review.scan_id, ...form, add_anyway: addAnyway });
      if (response.status === "possible_duplicate") {
        setDuplicateWarning(true);
        toast.warning("A matching card already exists. Confirm another copy or skip.");
        return;
      }
      toast.success(action === "skip" ? "Scan skipped." : "Card added to inventory.");
      onResolved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Review could not be saved.");
    } finally { setSaving(false); }
  };

  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="flex flex-wrap items-center gap-2 text-base">{form.card_name || "Unidentified card"}<Badge variant="outline">{Math.round(review.confidence * 100)}%</Badge><Badge variant={duplicateWarning ? "destructive" : "secondary"}>{duplicateWarning ? "Possible duplicate" : "Low confidence"}</Badge></CardTitle></CardHeader>
      <CardContent>
        <div className="grid gap-4 md:grid-cols-[150px_1fr]">
          {review.thumbnail_url ? <img src={review.thumbnail_url} alt="Scanned card awaiting review" className="aspect-[5/7] w-full max-w-[150px] rounded-lg object-cover shadow" /> : <div className="grid aspect-[5/7] max-w-[150px] place-items-center rounded-lg bg-muted text-xs text-muted-foreground">Private image unavailable</div>}
          <div>
            <div className="grid gap-3 sm:grid-cols-2">
              <ReviewField label="Card name" value={form.card_name} onChange={(value) => setForm((old) => ({ ...old, card_name: value }))} />
              <ReviewField label="Set" value={form.set_name} onChange={(value) => setForm((old) => ({ ...old, set_name: value }))} />
              <ReviewField label="Card number" value={form.card_number} onChange={(value) => setForm((old) => ({ ...old, card_number: value }))} />
              <ReviewField label="Rarity" value={form.rarity} onChange={(value) => setForm((old) => ({ ...old, rarity: value }))} />
            </div>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button variant="outline" disabled={saving} onClick={() => void act("skip")}>Skip</Button>
              <Button disabled={saving || !form.card_name.trim() || !form.set_name.trim() || !form.card_number.trim()} onClick={() => void act("confirm", duplicateWarning)}>{saving && <Loader2 className="animate-spin" />}{duplicateWarning ? "Add another copy" : "Confirm & add"}</Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ReviewField({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  return <label className="text-xs font-medium text-muted-foreground">{label}<Input className="mt-1 text-foreground" value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}
