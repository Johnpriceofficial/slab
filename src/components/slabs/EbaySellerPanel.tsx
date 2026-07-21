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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ebaySellerOperation, fetchEbayAccounts, fetchEbayBusinessPolicies, fetchEbayLocations, fetchEbaySyncCursors, startEbayOAuth } from "@/lib/slabs/data";
import { conditionPolicyValues, ebayListingTitle, evaluatePublishReadiness, requiredAspectNames, slabImagePaths } from "@/lib/slabs/ebay-listing";
import { canonicalMarketplaceSku } from "@/lib/slabs/marketplace-sku";
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
  // Discovery-populated options for the listing selectors (empty until an account-sync runs).
  const { data: locations = [] } = useQuery({ queryKey: ["ebay-locations", connected?.id], queryFn: () => fetchEbayLocations(connected!.id), enabled: !!connected });
  const { data: policies = [] } = useQuery({ queryKey: ["ebay-policies", connected?.id], queryFn: () => fetchEbayBusinessPolicies(connected!.id), enabled: !!connected });
  const policiesOfType = (type: string) => policies.filter((p) => p.policy_type === type);
  // Exactly one operation runs at a time; drives distinct progress labels.
  const [activeOperation, setActiveOperation] = useState<null | "account_sync" | "order_sync" | "finances_sync" | "prepare_listing" | "publish_listing">(null);
  const [syncSummary, setSyncSummary] = useState<Record<string, { status: string; count: number | null; error_code: string | null }> | null>(null);
  // order-sync PERSISTS orders (non-destructive) and returns the proposed sales;
  // this holds that result until the operator applies sales or dismisses it.
  const [orderAudit, setOrderAudit] = useState<null | { orders_synced: number; matched: number; unmatched: number; message: string; proposed_sales: Array<{ order_id: string; line_item_id: string; slab_id: string; sku: string; sold_price_cents: number; currency: string }> }>(null);
  const anyBusy = activeOperation !== null;
  // Persistent inline result of the last OAuth callback (shown until dismissed).
  const [callbackResult, setCallbackResult] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Typed preparation result: `ok` is true ONLY when eBay returned the
  // confirmation_required requirements. An error never marks the listing ready.
  const [prepared, setPrepared] = useState<null | { ok: boolean; failedResource: string | null; category_aspects?: unknown; condition_policies?: unknown }>(null);
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
  // Any listing-input change invalidates a prior preparation — the fetched
  // requirements no longer match the current inputs, so Publish must re-block.
  const change = (key: keyof typeof form, value: string) => { setForm((old) => ({ ...old, [key]: value })); setPrepared(null); };

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
    // order-sync PERSISTS orders + lines non-destructively and returns the sales
    // it would propose — it never marks anything sold. Show the result + preview.
    if (name === "ebay-order-sync") {
      if (result.status === "success") {
        setOrderAudit({ orders_synced: result.orders_synced ?? 0, matched: result.matched ?? 0, unmatched: result.unmatched ?? 0, message: result.message ?? "", proposed_sales: result.proposed_sales ?? [] });
        toast.success(result.message ?? "Orders synced.");
      } else toast.error(result.message ?? result.error_code ?? "Order sync failed.");
      refetch(); refetchCursors();
      return;
    }
    if (result.status === "success") toast.success("eBay synchronization completed.");
    else if (result.status === "partial") toast.warning("eBay sync finished, but some resources were unavailable — see details below.");
    else toast.error(result.message ?? result.error_code ?? "eBay synchronization failed.");
    // Honest per-resource summary for success/partial; cleared on hard error.
    setSyncSummary(result.status === "success" || result.status === "partial" ? ((result.resources ?? null) as typeof syncSummary) : null);
    refetch(); refetchCursors();
  };
  // SEPARATE consequential action: apply the persisted, selected sales (marks
  // slabs sold + writes comps). Server-gated by EBAY_APPLY_SALES_ENABLED and a
  // typed confirmation; the server acts only on already-persisted lines.
  const applyOrderSales = async () => {
    if (!connected || anyBusy || !orderAudit) return;
    const n = orderAudit.proposed_sales.length;
    if (n === 0) return;
    const typed = window.prompt(`This marks ${n} mapped slab(s) SOLD and writes sold comps. Type APPLY_SALES to confirm.`);
    if (typed !== "APPLY_SALES") { if (typed !== null) toast.info("Confirmation text did not match — nothing was applied."); return; }
    setActiveOperation("order_sync");
    const result = await ebaySellerOperation("ebay-order-sync", { account_id: connected.id, confirmation: "APPLY_SALES", sales: orderAudit.proposed_sales });
    setActiveOperation(null);
    if (result.status === "mutation_disabled") toast.error("Applying sales is disabled by server configuration.");
    else if (result.status === "success") {
      toast.success(`Applied ${result.sales_applied ?? 0} sale(s)${result.skipped_stale ? `, skipped ${result.skipped_stale} stale` : ""}.`);
      setOrderAudit(null);
    } else toast.error(result.message ?? result.error_code ?? "Applying eBay sales failed.");
    refetch(); refetchCursors();
  };
  const listingPayload = {
    account_id: connected?.id,
    slab_id: slab.id,
    sku: canonicalMarketplaceSku(slab),
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
    // Ready ONLY on the confirmation_required requirements. An error clears
    // readiness and keeps Publish disabled with the exact failed resource.
    if (result.status === "confirmation_required") {
      setPrepared({ ok: true, failedResource: null, category_aspects: result.category_aspects, condition_policies: result.condition_policies });
    } else {
      setPrepared({ ok: false, failedResource: result.error_code ?? result.message ?? "requirements_unavailable" });
      toast.error(result.message ?? result.error_code ?? "eBay listing requirements are unavailable.");
    }
  };
  const publish = async () => {
    if (anyBusy || !readiness.canPublish) return;
    // Images are resolved SERVER-SIDE at publish time; the client only gates.
    const typed = window.prompt(`Publish "${form.title}" to eBay as SKU ${listingPayload.sku} at USD ${form.price}? Type PUBLISH to confirm.`);
    if (typed !== "PUBLISH") { if (typed !== null) toast.info("Confirmation text did not match — nothing was published."); return; }
    setActiveOperation("publish_listing");
    const result = await ebaySellerOperation("ebay-list-item", { ...listingPayload, confirmation: "PUBLISH" });
    setActiveOperation(null);
    if (result.status === "mutation_disabled") toast.error("eBay listing publishing is disabled by server configuration.");
    else if (result.status === "published_unmapped") toast.error(`eBay listing ${result.listing_id ?? ""} is LIVE but local mapping failed — reconcile required. It was NOT withdrawn.`);
    else if (result.status === "success") toast.success(result.reconciled ? `Listing already published (${result.listing_id ?? ""}).` : `Published eBay listing ${result.listing_id ?? ""}.`);
    else toast.error(result.message ?? result.error_code ?? "eBay publish failed.");
  };
  // The complete client-side publish gate (the server's INCOMPLETE_LISTING is a
  // backstop). Recomputed every render from the current inputs + prepared state.
  const requiredAspects = requiredAspectNames(prepared?.category_aspects);
  const conditionValues = conditionPolicyValues(prepared?.condition_policies);
  const readiness = evaluatePublishReadiness({
    connected: !!connected,
    preparedOk: !!prepared?.ok,
    preparedFailedResource: prepared?.failedResource ?? null,
    sku: listingPayload.sku,
    title: form.title,
    description: form.description,
    price: Number(form.price),
    currency: "USD",
    categoryId: form.categoryId,
    condition: form.condition,
    locationKey: form.locationKey,
    fulfillmentPolicyId: form.fulfillmentPolicyId,
    paymentPolicyId: form.paymentPolicyId,
    returnPolicyId: form.returnPolicyId,
    locationKeys: locations.map((l) => l.merchant_location_key),
    fulfillmentPolicyIds: policiesOfType("fulfillment").map((p) => p.policy_id),
    paymentPolicyIds: policiesOfType("payment").map((p) => p.policy_id),
    returnPolicyIds: policiesOfType("return").map((p) => p.policy_id),
    imageCount: slabImagePaths(slab).length,
    requiredAspects,
    providedAspects: listingPayload.aspects,
  });

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
        <div className="rounded-md border p-3 text-xs">
          <div className="mb-1 flex items-center justify-between"><span className="font-medium">Order sync — {orderAudit.orders_synced} order(s) persisted · {orderAudit.matched} matched · {orderAudit.unmatched} unmatched</span><button type="button" aria-label="Dismiss order result" className="opacity-70 hover:opacity-100" onClick={() => setOrderAudit(null)}>×</button></div>
          <p className="mb-2 text-muted-foreground">Orders were recorded. Nothing was marked sold — that is a separate, confirmed step.</p>
          {orderAudit.proposed_sales.length > 0 ? (
            <>
              <ul className="mb-2 grid gap-0.5">{orderAudit.proposed_sales.map((s) => <li key={`${s.order_id}:${s.line_item_id}`}>SKU {s.sku} → would mark slab sold @ {s.currency} {(s.sold_price_cents / 100).toFixed(2)} <span className="text-muted-foreground">(order {s.order_id})</span></li>)}</ul>
              <Button size="sm" variant="destructive" disabled={anyBusy} onClick={applyOrderSales}>{activeOperation === "order_sync" ? "Applying…" : `Apply ${orderAudit.proposed_sales.length} sale(s)…`}</Button>
            </>
          ) : (
            <p className="text-muted-foreground">No proposed sales — no persisted line maps to inventory.</p>
          )}
        </div>
      )}
      <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Label>Listing title <span className="text-muted-foreground">({form.title.length}/80)</span></Label><Input value={form.title} maxLength={80} onChange={(e) => change("title", e.target.value)} /></div>
        <div className="sm:col-span-2"><Label>Description and grade disclosure</Label><Textarea value={form.description} onChange={(e) => change("description", e.target.value)} /></div>
        <div><Label>Price (USD)</Label><Input type="number" min="0" step="0.01" value={form.price} onChange={(e) => change("price", e.target.value)} /></div>
        <div><Label>Condition policy value</Label><Input value={form.condition} onChange={(e) => change("condition", e.target.value)} /></div>
        <div><Label>Category ID</Label><Input value={form.categoryId} onChange={(e) => change("categoryId", e.target.value)} /></div>
        <DiscoverySelect label="Inventory location" value={form.locationKey} onChange={(v) => change("locationKey", v)} options={locations.map((l) => ({ value: l.merchant_location_key, label: l.status ? `${l.merchant_location_key} (${l.status})` : l.merchant_location_key }))} emptyHint="No locations yet — run account sync" />
        <DiscoverySelect label="Fulfillment policy" value={form.fulfillmentPolicyId} onChange={(v) => change("fulfillmentPolicyId", v)} options={policiesOfType("fulfillment").map((p) => ({ value: p.policy_id, label: p.name ?? p.policy_id }))} emptyHint="No policies yet — run account sync" />
        <DiscoverySelect label="Payment policy" value={form.paymentPolicyId} onChange={(v) => change("paymentPolicyId", v)} options={policiesOfType("payment").map((p) => ({ value: p.policy_id, label: p.name ?? p.policy_id }))} emptyHint="No policies yet — run account sync" />
        <DiscoverySelect label="Return policy" value={form.returnPolicyId} onChange={(v) => change("returnPolicyId", v)} options={policiesOfType("return").map((p) => ({ value: p.policy_id, label: p.name ?? p.policy_id }))} emptyHint="No policies yet — run account sync" />
        <div className="flex items-end gap-2"><Button variant="outline" disabled={anyBusy} onClick={prepare}>{activeOperation === "prepare_listing" ? "Loading…" : "Load current eBay requirements"}</Button><Button disabled={anyBusy || !readiness.canPublish} onClick={publish}>{activeOperation === "publish_listing" ? "Publishing…" : "Publish with confirmation"}</Button></div>
        {prepared?.ok && (
          <div className="sm:col-span-2 space-y-1 text-xs">
            {requiredAspects.length > 0 && <p className="text-destructive">eBay requires these item aspects for this category (not yet collected, so Publish is blocked): {requiredAspects.join(", ")}.</p>}
            {conditionValues.length > 0 && <p className="text-muted-foreground">Allowed condition values: {conditionValues.join(", ")}.</p>}
          </div>
        )}
        {!readiness.canPublish && (
          <ul className="sm:col-span-2 grid gap-0.5 text-xs text-muted-foreground">{readiness.blockers.map((b) => <li key={b}>• {b}</li>)}</ul>
        )}
      </div>
      <p className="text-muted-foreground">Seller orders and Finances records are stored server-side. Active Browse listings remain asking-price/reference evidence and are never sold comparables. Unknown external enum and CustomCode values are preserved as text.</p>
    </div> : <div className="space-y-3 text-sm"><p className="text-muted-foreground">Not connected. Active eBay Browse references can still be used when application credentials exist, but they are never labeled as sold comps.</p><Button variant="outline" onClick={connect} disabled={connecting}>{connecting ? "Starting eBay sign-in…" : "Connect eBay seller account"}</Button><p className="text-xs text-muted-foreground">Restricted capabilities remain unavailable until eBay grants the application/account access.</p></div>}
  </CardContent></Card>;
}

// A listing selector backed by account-discovery data. Falls back to a hint (not
// a free-text field) when discovery hasn't populated options yet, so an operator
// can never hand-type an invalid location key or policy ID.
function DiscoverySelect({ label, value, onChange, options, emptyHint }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  emptyHint: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      {options.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">{emptyHint}</p>
      ) : (
        <Select value={value || undefined} onValueChange={onChange}>
          <SelectTrigger><SelectValue placeholder={`Select ${label.toLowerCase()}`} /></SelectTrigger>
          <SelectContent>
            {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
