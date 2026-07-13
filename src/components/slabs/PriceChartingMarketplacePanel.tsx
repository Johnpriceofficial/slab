import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, RefreshCw, Store, Truck, Ban, RotateCcw } from "lucide-react";
import { fetchPriceChartingOffers, invokePriceChartingMarketplace, syncAllPriceChartingOffers } from "@/lib/slabs/data";
import { centsToInputString, formatCents } from "@/lib/slabs/format";
import type { PriceChartingOffer, Slab } from "@/lib/slabs/types";

function skuFor(slab: Slab): string {
  return `GCV${String(slab.inventory_number).padStart(6, "0")}`;
}

function generatedDescription(slab: Slab): string {
  return [slab.card_name, slab.set_name, slab.card_number ? `#${slab.card_number}` : null, slab.grader, slab.grade_label, slab.grade]
    .filter(Boolean).join(" · ").slice(0, 300);
}

export function PriceChartingMarketplacePanel({ slab }: { slab: Slab }) {
  const queryClient = useQueryClient();
  const { data: offers = [], isLoading } = useQuery({
    queryKey: ["pricecharting-offers", slab.id],
    queryFn: () => fetchPriceChartingOffers(slab.id),
  });
  const current = offers[0] ?? null;
  const [busy, setBusy] = useState(false);
  const [condition, setCondition] = useState("");
  const [costBasis, setCostBasis] = useState(centsToInputString(slab.cost_basis_cents ?? null));
  const [price, setPrice] = useState(centsToInputString(slab.final_value_cents));
  const [minimum, setMinimum] = useState("");
  const [description, setDescription] = useState(generatedDescription(slab));
  const [confirmed, setConfirmed] = useState(false);
  const [tracking, setTracking] = useState("");
  const [feedback, setFeedback] = useState("2");

  const eligible = slab.verification_status === "verified" && !!slab.pricecharting_product_id && slab.visual_confirmation_status !== "user_rejected";
  const realized = useMemo(() => {
    if (current?.sale_price_cents == null || current.cost_basis_cents == null) return null;
    return current.sale_price_cents + (current.shipping_premium_cents ?? 0) - current.cost_basis_cents;
  }, [current]);

  const refresh = async () => {
    if (!current) return;
    setBusy(true);
    const result = await invokePriceChartingMarketplace(slab.id, { action: "details", offer_id: current.offer_id }, "synced");
    setBusy(false);
    if (result.status === "error") toast.error(result.message);
    else {
      toast.success("Marketplace offer synchronized.");
      queryClient.invalidateQueries({ queryKey: ["pricecharting-offers", slab.id] });
      queryClient.invalidateQueries({ queryKey: ["slab", slab.id] });
    }
  };

  const publish = async () => {
    if (!eligible) return toast.error("Verify the slab and confirm a PriceCharting product before listing.");
    if (!condition) return toast.error("Choose the PriceCharting condition supplied by your seller account.");
    if (!price.trim()) return toast.error("Enter a listing price.");
    if (!confirmed) return toast.error("Review the product, artwork, disclosure, cost basis, and prices, then confirm.");
    if (!window.confirm("Publish this slab to the PriceCharting Marketplace now?")) return;
    setBusy(true);
    const result = await invokePriceChartingMarketplace(slab.id, {
      action: "publish",
      product_id: slab.pricecharting_product_id!,
      product_name: slab.pricecharting_product_name ?? undefined,
      sku: skuFor(slab),
      condition_id: Number(condition),
      cost_basis_dollars: costBasis || undefined,
      price_max_dollars: price,
      price_min_dollars: minimum || undefined,
      description,
      pristine: /pristine/i.test(slab.grade_label ?? ""),
      confirm: true,
      idempotency_key: `publish-${slab.id}-${slab.pricecharting_product_id}`,
    }, "published");
    setBusy(false);
    if (result.status === "error") toast.error(result.message);
    else {
      toast.success("PriceCharting listing published and linked to inventory.");
      setConfirmed(false);
      queryClient.invalidateQueries({ queryKey: ["pricecharting-offers", slab.id] });
      queryClient.invalidateQueries({ queryKey: ["slab", slab.id] });
    }
  };

  const action = async (kind: "end" | "ship" | "refund" | "feedback" | "edit") => {
    if (!current) return;
    if (kind === "refund") {
      if (window.prompt("Refunds are financial actions. Type REFUND to continue.") !== "REFUND") return;
    } else if (!window.confirm(`${kind === "ship" ? "Mark shipped" : kind === "end" ? "End listing" : kind === "feedback" ? "Submit feedback" : "Change price"} for offer ${current.offer_id}?`)) return;
    setBusy(true);
    const result = await invokePriceChartingMarketplace(slab.id, {
      action: kind,
      offer_id: current.offer_id,
      ...(kind === "ship" ? { tracking_number: tracking || undefined, confirm: true } : {}),
      ...(kind === "refund" ? { confirm_refund: true } : {}),
      ...(kind === "end" ? { confirm: true } : {}),
      ...(kind === "feedback" ? { rating: Number(feedback) as 2 | 1 | 0 | -1 | -2, confirm: true } : {}),
      ...(kind === "edit" ? { price_max_dollars: price, price_min_dollars: minimum || undefined, confirm: true } : {}),
    }, kind === "edit" ? "edited" : kind === "end" ? "ended" : kind === "ship" ? "shipped" : kind === "refund" ? "refunded" : "feedback");
    setBusy(false);
    if (result.status === "error") toast.error(result.message);
    else {
      toast.success("Marketplace action completed.");
      queryClient.invalidateQueries({ queryKey: ["pricecharting-offers", slab.id] });
      queryClient.invalidateQueries({ queryKey: ["slab", slab.id] });
    }
  };

  return (
    <Card className="mt-6">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div><CardTitle className="flex items-center gap-2"><Store className="h-5 w-5" /> PriceCharting Marketplace</CardTitle><p className="mt-1 text-xs text-muted-foreground">Seller listings and completed sales stay separate from guide values.</p></div>
        <Button variant="outline" size="sm" disabled={busy} onClick={current ? refresh : async () => {
          setBusy(true); const result = await syncAllPriceChartingOffers(); setBusy(false);
          if (result.status === "success") toast.success(`Synchronized ${result.offers_updated ?? 0} offer(s).`);
          else toast.error(result.message ?? "Sync failed.");
        }}><RefreshCw className="mr-1 h-4 w-4" /> Sync now</Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading marketplace state…</p> : current ? (
          <OfferState offer={current} realized={realized} />
        ) : (
          <div className="rounded border p-3 text-sm">
            <p className="font-medium">Not listed</p>
            <p className="text-muted-foreground">Product: {slab.pricecharting_product_name ?? "Unlinked"} · ID {slab.pricecharting_product_id ?? "—"}</p>
            {!eligible && <p className="mt-2 text-amber-700">A verified slab and non-rejected PriceCharting product link are required.</p>}
          </div>
        )}

        {(!current || current.offer_status === "available") && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label>Permanent SKU</Label><Input value={skuFor(slab)} readOnly /></div>
            <div><Label>Condition ID</Label><Select value={condition} onValueChange={setCondition}><SelectTrigger><SelectValue placeholder="Select PriceCharting condition" /></SelectTrigger><SelectContent>{[1,2,3,5,6,7,8,9,10,13].map((id) => <SelectItem key={id} value={String(id)}>Condition {id}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>Cost basis ($) <Badge variant="outline">USER</Badge></Label><Input inputMode="decimal" value={costBasis} onChange={(e) => setCostBasis(e.target.value)} /></div>
            <div><Label>Listing price ($)</Label><Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
            <div><Label>Minimum declining price ($)</Label><Input inputMode="decimal" value={minimum} onChange={(e) => setMinimum(e.target.value)} /></div>
            <div className="sm:col-span-2"><Label>Grade/variation disclosure</Label><Textarea maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} /><p className="text-right text-xs text-muted-foreground">{description.length}/300</p></div>
            {!current && <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" /><span>I verified the product/artwork, grade, variation, condition, cost basis, listing price, and minimum price. Marketplace fees are unavailable until returned by the provider.</span></label>}
            <div className="flex gap-2 sm:col-span-2">
              {!current ? <Button disabled={busy || !eligible} onClick={publish}>{busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}List on PriceCharting</Button> : <Button variant="outline" disabled={busy} onClick={() => action("edit")}>Change price</Button>}
            </div>
          </div>
        )}

        {current && (
          <div className="space-y-3 border-t pt-4">
            <div className="flex gap-2"><Input placeholder="Tracking number (optional)" value={tracking} onChange={(e) => setTracking(e.target.value)} /><Button variant="outline" disabled={busy} onClick={() => action("ship")}><Truck className="mr-1 h-4 w-4" /> Mark shipped</Button></div>
            <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => action("end")}><Ban className="mr-1 h-4 w-4" /> End listing</Button><Button variant="destructive" disabled={busy || current.offer_status !== "sold"} onClick={() => action("refund")}><RotateCcw className="mr-1 h-4 w-4" /> Refund</Button><Select value={feedback} onValueChange={setFeedback}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent>{[2,1,0,-1,-2].map((r) => <SelectItem key={r} value={String(r)}>Feedback {r}</SelectItem>)}</SelectContent></Select><Button variant="outline" disabled={busy || current.offer_status !== "sold"} onClick={() => action("feedback")}>Submit feedback</Button></div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function OfferState({ offer, realized }: { offer: PriceChartingOffer; realized: number | null }) {
  return <div className="grid gap-2 rounded border p-3 text-sm sm:grid-cols-4">
    <div><p className="text-xs text-muted-foreground">Status</p><Badge variant="outline">{offer.offer_status}</Badge></div>
    <div><p className="text-xs text-muted-foreground">Offer ID</p><p className="font-mono">{offer.offer_id}</p></div>
    <div><p className="text-xs text-muted-foreground">Current / maximum</p><p>{formatCents(offer.price_max_cents)}</p></div>
    <div><p className="text-xs text-muted-foreground">Minimum</p><p>{formatCents(offer.price_min_cents)}</p></div>
    <div><p className="text-xs text-muted-foreground">Listed</p><p>{offer.listed_at?.slice(0, 10) ?? "—"}</p></div>
    <div><p className="text-xs text-muted-foreground">Sold</p><p>{offer.sold_at?.slice(0, 10) ?? "—"}</p></div>
    <div><p className="text-xs text-muted-foreground">Tracking</p><p>{offer.shipped ? "Shipped" : "Not shipped"}</p></div>
    <div><p className="text-xs text-muted-foreground">Last sync</p><p>{offer.last_synced_at.slice(0, 16).replace("T", " ")}</p></div>
    <div className="sm:col-span-4"><p className="text-xs text-muted-foreground">Preliminary realized profit <Badge variant="outline">CALCULATED</Badge></p><p className="font-semibold">{realized === null ? "Unavailable until sale and cost basis exist" : formatCents(realized)}</p><p className="text-xs text-muted-foreground">Excludes marketplace fees/refunds until the provider returns them.</p></div>
  </div>;
}
