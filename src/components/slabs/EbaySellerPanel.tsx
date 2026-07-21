import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ebayCallbackResultMessage } from "@/lib/slabs/ebay-callback";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ebaySellerOperation, fetchEbayAccounts, startEbayOAuth } from "@/lib/slabs/data";
import type { Slab } from "@/lib/slabs/types";

export function EbaySellerPanel({ slab }: { slab: Slab }) {
  const { data: accounts = [], refetch } = useQuery({ queryKey: ["ebay-accounts"], queryFn: fetchEbayAccounts });
  const connected = accounts.find((account) => account.connection_status === "connected");
  const [busy, setBusy] = useState(false);
  // Persistent inline result of the last OAuth callback (shown until dismissed).
  const [callbackResult, setCallbackResult] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [prepared, setPrepared] = useState<Record<string, any> | null>(null);
  const [form, setForm] = useState({
    title: `${slab.card_name ?? "Graded card"} ${slab.grader ?? ""} ${slab.grade ?? ""}`.trim(),
    description: `${slab.card_name ?? "Graded card"} · ${slab.set_name ?? ""} · #${slab.card_number ?? ""} · ${slab.grader ?? ""} ${slab.grade_label ?? ""} ${slab.grade ?? ""}`.slice(0, 1000),
    price: slab.final_value_cents ? (slab.final_value_cents / 100).toFixed(2) : "",
    categoryId: "",
    locationKey: "",
    fulfillmentPolicyId: "",
    paymentPolicyId: "",
    returnPolicyId: "",
    condition: "GRADED",
  });
  const change = (key: keyof typeof form, value: string) => setForm((old) => ({ ...old, [key]: value }));

  // Surface the OAuth callback result (?ebay=<result>) once when we land back
  // from the eBay hop: toast, refetch accounts on success, then strip the marker
  // from the URL without reloading.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("ebay");
    if (!result) return;
    const { tone, message } = ebayCallbackResultMessage(result);
    if (tone === "success") toast.success(message);
    else if (tone === "info") toast.info(message);
    else toast.error(message);
    setCallbackResult(result); // persistent inline banner until dismissed
    if (result === "connected") void refetch();
    params.delete("ebay");
    const clean = window.location.pathname + (params.toString() ? `?${params.toString()}` : "") + window.location.hash;
    window.history.replaceState({}, "", clean);
  }, [refetch]);

  const connect = async () => {
    if (connecting) return; // single-flight: never mint parallel OAuth states
    setConnecting(true);
    const result = await startEbayOAuth();
    if (result.status === "success" && result.authorization_url) { window.location.assign(result.authorization_url); return; } // navigating away — stay disabled
    toast.info(result.message ?? "eBay seller integration is not configured.");
    setConnecting(false); // restore only on a failed start
  };
  const sync = async (name: "ebay-account-sync" | "ebay-order-sync" | "ebay-finances-sync") => {
    if (!connected) return;
    setBusy(true);
    const result = await ebaySellerOperation(name, { account_id: connected.id });
    setBusy(false);
    if (result.status === "success") toast.success("eBay synchronization completed.");
    else toast.error(result.message ?? "eBay synchronization failed.");
    refetch();
  };
  const listingPayload = {
    account_id: connected?.id,
    slab_id: slab.id,
    sku: String(slab.inventory_number),
    marketplace_id: "EBAY_US",
    title: form.title,
    description: form.description,
    price_value: Number(form.price),
    currency: "USD",
    category_id: form.categoryId,
    merchant_location_key: form.locationKey,
    fulfillment_policy_id: form.fulfillmentPolicyId,
    payment_policy_id: form.paymentPolicyId,
    return_policy_id: form.returnPolicyId,
    condition: form.condition,
    quantity: 1,
    aspects: {},
    image_urls: [],
  };
  const prepare = async () => {
    setBusy(true);
    const result = await ebaySellerOperation("ebay-list-item", listingPayload);
    setBusy(false);
    setPrepared(result);
    if (result.status === "error" || result.status === "unavailable") toast.error(result.message ?? "eBay listing requirements are unavailable.");
  };
  const publish = async () => {
    if (!window.confirm("Publish this item to eBay with the displayed price, condition, policies, and SKU?")) return;
    setBusy(true);
    const result = await ebaySellerOperation("ebay-list-item", { ...listingPayload, confirmation: "PUBLISH" });
    setBusy(false);
    if (result.status === "success") toast.success(`Published eBay listing ${result.listing_id ?? ""}.`);
    else toast.error(result.message ?? "eBay publish failed.");
  };

  const banner = callbackResult ? ebayCallbackResultMessage(callbackResult) : null;
  const bannerClass = banner?.tone === "success"
    ? "border-green-600/40 bg-green-600/5 text-green-700"
    : banner?.tone === "info"
      ? "border-amber-500/40 bg-amber-50 text-amber-800"
      : "border-destructive/40 bg-destructive/5 text-destructive";

  return <Card className="mt-6"><CardHeader><CardTitle>eBay Listing, Orders &amp; Fulfillment</CardTitle></CardHeader><CardContent>
    {banner && (
      <div role="status" className={`mb-4 flex items-start justify-between gap-3 rounded-md border p-3 text-sm ${bannerClass}`}>
        <span>{banner.message}</span>
        <button type="button" aria-label="Dismiss eBay status" className="shrink-0 opacity-70 hover:opacity-100" onClick={() => setCallbackResult(null)}>×</button>
      </div>
    )}
    {connected ? <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2"><Badge>Connected</Badge><span>{connected.display_label ?? "eBay seller account"}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => sync("ebay-account-sync")}>Verify privileges</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => sync("ebay-order-sync")}>Sync orders</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => sync("ebay-finances-sync")}>Sync fees</Button></div>
      <p>Privileges: {busy ? "Checking…" : connected.privilege_status === "verified" ? "Verified" : "Not verified"}{connected.last_synced_at ? ` · Last account sync: ${connected.last_synced_at.slice(0, 16).replace("T", " ")}` : ""}</p>
      <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Label>Listing title</Label><Input value={form.title} onChange={(e) => change("title", e.target.value)} /></div>
        <div className="sm:col-span-2"><Label>Description and grade disclosure</Label><Textarea value={form.description} onChange={(e) => change("description", e.target.value)} /></div>
        <div><Label>Price (USD)</Label><Input type="number" min="0" step="0.01" value={form.price} onChange={(e) => change("price", e.target.value)} /></div>
        <div><Label>Condition policy value</Label><Input value={form.condition} onChange={(e) => change("condition", e.target.value)} /></div>
        <div><Label>Category ID</Label><Input value={form.categoryId} onChange={(e) => change("categoryId", e.target.value)} /></div>
        <div><Label>Inventory location key</Label><Input value={form.locationKey} onChange={(e) => change("locationKey", e.target.value)} /></div>
        <div><Label>Fulfillment policy ID</Label><Input value={form.fulfillmentPolicyId} onChange={(e) => change("fulfillmentPolicyId", e.target.value)} /></div>
        <div><Label>Payment policy ID</Label><Input value={form.paymentPolicyId} onChange={(e) => change("paymentPolicyId", e.target.value)} /></div>
        <div><Label>Return policy ID</Label><Input value={form.returnPolicyId} onChange={(e) => change("returnPolicyId", e.target.value)} /></div>
        <div className="flex items-end gap-2"><Button variant="outline" disabled={busy} onClick={prepare}>Load current eBay requirements</Button><Button disabled={busy || !prepared || !form.price} onClick={publish}>Publish with confirmation</Button></div>
        {prepared && <p className="sm:col-span-2 text-xs text-muted-foreground">eBay returned current privileges, locations, business policies, category aspects, and condition policies. Publishing remains blocked until the required IDs are supplied and explicitly confirmed.</p>}
      </div>
      <p className="text-muted-foreground">Seller orders and Finances records are stored server-side. Active Browse listings remain asking-price/reference evidence and are never sold comparables. Unknown external enum and CustomCode values are preserved as text.</p>
    </div> : <div className="space-y-3 text-sm"><p className="text-muted-foreground">Not connected. Active eBay Browse references can still be used when application credentials exist, but they are never labeled as sold comps.</p><Button variant="outline" onClick={connect} disabled={connecting}>{connecting ? "Starting eBay sign-in…" : "Connect eBay seller account"}</Button><p className="text-xs text-muted-foreground">Restricted capabilities remain unavailable until eBay grants the application/account access.</p></div>}
  </CardContent></Card>;
}
