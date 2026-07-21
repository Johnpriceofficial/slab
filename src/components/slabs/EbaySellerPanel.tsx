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
import { ebaySellerOperation, fetchEbayAccounts, fetchEbaySyncCursors, signedImageUrl, startEbayOAuth } from "@/lib/slabs/data";
import { ebayListingTitle, ebaySkuForSlab, slabImagePaths } from "@/lib/slabs/ebay-listing";
import type { Slab } from "@/lib/slabs/types";

export function EbaySellerPanel({ slab }: { slab: Slab }) {
  const { data: accounts = [], refetch } = useQuery({ queryKey: ["ebay-accounts"], queryFn: fetchEbayAccounts });
  const connected = accounts.find((account) => account.connection_status === "connected");
  // Per-resource sync timestamps (authoritative "last synced", not the old shared one).
  const { data: cursors = [], refetch: refetchCursors } = useQuery({
    queryKey: ["ebay-sync-cursors", connected?.id],
    queryFn: () => fetchEbaySyncCursors(connected!.id),
    enabled: !!connected,
  });
  const cursorFor = (resource: string) => cursors.find((c) => c.resource_type === resource) ?? null;
  // Exactly one operation runs at a time; drives distinct progress labels.
  const [activeOperation, setActiveOperation] = useState<null | "account_sync" | "order_sync" | "finances_sync" | "prepare_listing" | "publish_listing">(null);
  const [syncSummary, setSyncSummary] = useState<Record<string, { status: string; count: number | null; error_code: string | null }> | null>(null);
  // order-sync's default response is a non-mutating audit; this holds that preview
  // until the operator either applies the sales or dismisses it.
  const [orderAudit, setOrderAudit] = useState<null | { order_count: number; message: string; proposed_sales: Array<{ order_id: string; line_item_id: string; slab_id: string; sku: string; sold_price_cents: number; currency: string }> }>(null);
  const anyBusy = activeOperation !== null;
  // Persistent inline result of the last OAuth callback (shown until dismissed).
  const [callbackResult, setCallbackResult] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [prepared, setPrepared] = useState<Record<string, any> | null>(null);
  const [form, setForm] = useState({
    title: ebayListingTitle(slab),
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
    if (!connected || anyBusy) return;
    const op = name === "ebay-account-sync" ? "account_sync" : name === "ebay-order-sync" ? "order_sync" : "finances_sync";
    setActiveOperation(op);
    const result = await ebaySellerOperation(name, { account_id: connected.id });
    setActiveOperation(null);
    // order-sync default: a non-mutating audit. Nothing was written; show the
    // preview and let the operator explicitly apply the sales.
    if (result.status === "audit") {
      setOrderAudit({ order_count: result.order_count ?? 0, message: result.message ?? "", proposed_sales: result.proposed_sales ?? [] });
      toast.info(result.message ?? "eBay orders fetched (audit — nothing changed).");
      refetchCursors();
      return;
    }
    if (result.status === "success") toast.success("eBay synchronization completed.");
    else if (result.status === "partial") toast.warning("eBay sync finished, but some resources were unavailable — see details below.");
    else toast.error(result.message ?? result.error_code ?? "eBay synchronization failed.");
    // Honest per-resource summary for success/partial; cleared on hard error.
    setSyncSummary(result.status === "success" || result.status === "partial" ? ((result.resources ?? null) as typeof syncSummary) : null);
    refetch(); refetchCursors();
  };
  // The consequential path: record orders privately AND mark mapped slabs sold.
  const applyOrderSales = async () => {
    if (!connected || anyBusy || !orderAudit) return;
    const n = orderAudit.proposed_sales.length;
    if (!window.confirm(`Record ${orderAudit.order_count} eBay order(s) and mark ${n} mapped slab(s) SOLD? This writes sold comps and updates inventory.`)) return;
    setActiveOperation("order_sync");
    const result = await ebaySellerOperation("ebay-order-sync", { account_id: connected.id, confirmation: "APPLY_SALES" });
    setActiveOperation(null);
    if (result.status === "success") {
      toast.success(`Recorded ${result.orders_synced ?? 0} order(s); marked ${result.sales_applied ?? 0} slab(s) sold.`);
      setOrderAudit(null);
    } else toast.error(result.message ?? result.error_code ?? "Applying eBay sales failed.");
    refetch(); refetchCursors();
  };
  const listingPayload = {
    account_id: connected?.id,
    slab_id: slab.id,
    sku: ebaySkuForSlab(slab),
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
    // image_urls are resolved to fresh signed URLs at publish time (see publish()).
  };
  const prepare = async () => {
    if (anyBusy) return;
    setActiveOperation("prepare_listing");
    const result = await ebaySellerOperation("ebay-list-item", listingPayload);
    setActiveOperation(null);
    setPrepared(result);
    if (result.status === "error" || result.status === "unavailable") toast.error(result.message ?? "eBay listing requirements are unavailable.");
  };
  const publish = async () => {
    if (anyBusy) return;
    // Real slab photos (front, then back) resolved to short-lived signed URLs eBay
    // fetches at publish time — never an empty image list.
    const image_urls = (await Promise.all(slabImagePaths(slab).map((p) => signedImageUrl(p, 3600)))).filter((u): u is string => Boolean(u));
    if (image_urls.length === 0) { toast.error("This slab has no stored images — add photos before publishing to eBay."); return; }
    if (!window.confirm(`Publish to eBay with ${image_urls.length} photo(s), SKU ${listingPayload.sku}, and the displayed price, condition, and policies?`)) return;
    setActiveOperation("publish_listing");
    const result = await ebaySellerOperation("ebay-list-item", { ...listingPayload, image_urls, confirmation: "PUBLISH" });
    setActiveOperation(null);
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
      <div className="flex flex-wrap items-center gap-2"><Badge>Connected</Badge><span>{connected.display_label ?? "eBay seller account"}</span>
        <Button size="sm" variant="outline" disabled={anyBusy} onClick={() => sync("ebay-account-sync")}>{activeOperation === "account_sync" ? "Checking…" : "Verify privileges"}</Button>
        <Button size="sm" variant="outline" disabled={anyBusy} onClick={() => sync("ebay-order-sync")}>{activeOperation === "order_sync" ? "Syncing orders…" : "Sync orders"}</Button>
        <Button size="sm" variant="outline" disabled={anyBusy} onClick={() => sync("ebay-finances-sync")}>{activeOperation === "finances_sync" ? "Syncing fees…" : "Sync fees"}</Button></div>
      <p>Privileges: {activeOperation === "account_sync" ? "Checking…" : connected.privilege_status === "verified" ? "Verified" : "Not verified"}{connected.connected_at ? ` · Connected ${connected.connected_at.slice(0, 16).replace("T", " ")}` : ""}{cursorFor("account_discovery")?.last_synced_at ? ` · Account discovery ${cursorFor("account_discovery")!.last_synced_at!.slice(0, 16).replace("T", " ")}${cursorFor("account_discovery")?.cursor_value ? ` (${cursorFor("account_discovery")!.cursor_value} records)` : ""}` : ""}</p>
      <p className="text-xs text-muted-foreground">Orders last synced: {cursorFor("orders")?.last_synced_at?.slice(0, 16).replace("T", " ") ?? "never"} · Finances last synced: {cursorFor("finances")?.last_synced_at?.slice(0, 16).replace("T", " ") ?? "never"}</p>
      {syncSummary && (
        <div className="rounded-md border p-3 text-xs">
          <div className="mb-1 flex items-center justify-between"><span className="font-medium">Last account-discovery result</span><button type="button" aria-label="Dismiss sync summary" className="opacity-70 hover:opacity-100" onClick={() => setSyncSummary(null)}>×</button></div>
          <ul className="grid gap-0.5 sm:grid-cols-2">{Object.entries(syncSummary).map(([res, r]) => <li key={res}><span className={r.status === "success" ? "text-green-700" : r.status === "error" ? "text-destructive" : "text-amber-700"}>{r.status}</span> — {res.replace(/_/g, " ")}{r.count != null ? ` (${r.count})` : ""}{r.error_code ? ` · ${r.error_code}` : ""}</li>)}</ul>
        </div>
      )}
      {orderAudit && (
        <div className="rounded-md border border-amber-500/40 bg-amber-50 p-3 text-xs text-amber-900">
          <div className="mb-1 flex items-center justify-between"><span className="font-medium">Order sync — audit (nothing written yet)</span><button type="button" aria-label="Dismiss order audit" className="opacity-70 hover:opacity-100" onClick={() => setOrderAudit(null)}>×</button></div>
          <p className="mb-2">{orderAudit.message}</p>
          {orderAudit.proposed_sales.length > 0 && (
            <ul className="mb-2 grid gap-0.5">{orderAudit.proposed_sales.map((s) => <li key={`${s.order_id}:${s.line_item_id}`}>SKU {s.sku} → mark slab sold @ {s.currency} {(s.sold_price_cents / 100).toFixed(2)} <span className="text-amber-700">(order {s.order_id})</span></li>)}</ul>
          )}
          {orderAudit.proposed_sales.length > 0 && (
            <Button size="sm" variant="destructive" disabled={anyBusy} onClick={applyOrderSales}>{activeOperation === "order_sync" ? "Applying…" : `Apply ${orderAudit.proposed_sales.length} sale(s)`}</Button>
          )}
        </div>
      )}
      <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Label>Listing title <span className="text-muted-foreground">({form.title.length}/80)</span></Label><Input value={form.title} maxLength={80} onChange={(e) => change("title", e.target.value)} /></div>
        <div className="sm:col-span-2"><Label>Description and grade disclosure</Label><Textarea value={form.description} onChange={(e) => change("description", e.target.value)} /></div>
        <div><Label>Price (USD)</Label><Input type="number" min="0" step="0.01" value={form.price} onChange={(e) => change("price", e.target.value)} /></div>
        <div><Label>Condition policy value</Label><Input value={form.condition} onChange={(e) => change("condition", e.target.value)} /></div>
        <div><Label>Category ID</Label><Input value={form.categoryId} onChange={(e) => change("categoryId", e.target.value)} /></div>
        <div><Label>Inventory location key</Label><Input value={form.locationKey} onChange={(e) => change("locationKey", e.target.value)} /></div>
        <div><Label>Fulfillment policy ID</Label><Input value={form.fulfillmentPolicyId} onChange={(e) => change("fulfillmentPolicyId", e.target.value)} /></div>
        <div><Label>Payment policy ID</Label><Input value={form.paymentPolicyId} onChange={(e) => change("paymentPolicyId", e.target.value)} /></div>
        <div><Label>Return policy ID</Label><Input value={form.returnPolicyId} onChange={(e) => change("returnPolicyId", e.target.value)} /></div>
        <div className="flex items-end gap-2"><Button variant="outline" disabled={anyBusy} onClick={prepare}>{activeOperation === "prepare_listing" ? "Loading…" : "Load current eBay requirements"}</Button><Button disabled={anyBusy || !prepared || !form.price} onClick={publish}>{activeOperation === "publish_listing" ? "Publishing…" : "Publish with confirmation"}</Button></div>
        {prepared && <p className="sm:col-span-2 text-xs text-muted-foreground">eBay returned current privileges, locations, business policies, category aspects, and condition policies. Publishing remains blocked until the required IDs are supplied and explicitly confirmed.</p>}
      </div>
      <p className="text-muted-foreground">Seller orders and Finances records are stored server-side. Active Browse listings remain asking-price/reference evidence and are never sold comparables. Unknown external enum and CustomCode values are preserved as text.</p>
    </div> : <div className="space-y-3 text-sm"><p className="text-muted-foreground">Not connected. Active eBay Browse references can still be used when application credentials exist, but they are never labeled as sold comps.</p><Button variant="outline" onClick={connect} disabled={connecting}>{connecting ? "Starting eBay sign-in…" : "Connect eBay seller account"}</Button><p className="text-xs text-muted-foreground">Restricted capabilities remain unavailable until eBay grants the application/account access.</p></div>}
  </CardContent></Card>;
}
