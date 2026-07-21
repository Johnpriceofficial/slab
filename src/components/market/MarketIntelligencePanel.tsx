/**
 * Read-only Market Intelligence panel for a slab or raw card. Keeps verified
 * sales, active listings, and PriceCharting tiers in SEPARATE sections and never
 * labels an asking price as sold evidence. Renders whatever the server returns;
 * it computes and persists nothing.
 */

import { AlertTriangle, Gauge, Loader2, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCents } from "@/lib/slabs/format";
import { GRADE_TIER_LABELS } from "@/lib/market/grade-tier";
import type { MarketIntelligence } from "@/lib/market/client";

const pct = (n: number) => `${Math.round(n * 100)}%`;
const money = (c: number | null) => (c === null ? "—" : formatCents(c));
const date = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

const SOURCE_LABEL: Record<string, string> = {
  pricecharting: "PriceCharting",
  ebay_active: "eBay active",
  ebay_sold: "Connected seller sales",
  population: "Population",
  manual: "Operator comps",
};

// Success reads green, "nothing found" reads neutral, everything else (not
// configured / failed / rate-limited) reads amber — so a degraded provider is
// never mistaken for zero market activity.
const STATUS_META: Record<string, { label: string; cls: string }> = {
  success: { label: "OK", cls: "border-emerald-500/40 bg-emerald-50 text-emerald-700" },
  no_results: { label: "No results", cls: "border-muted bg-muted text-muted-foreground" },
  not_configured: { label: "Not configured", cls: "border-slate-400/40 bg-slate-50 text-slate-600" },
  unauthorized: { label: "Auth failed", cls: "border-amber-400/50 bg-amber-50 text-amber-800" },
  rate_limited: { label: "Rate-limited", cls: "border-amber-400/50 bg-amber-50 text-amber-800" },
  provider_error: { label: "Failed", cls: "border-amber-400/50 bg-amber-50 text-amber-800" },
  network_error: { label: "Unreachable", cls: "border-amber-400/50 bg-amber-50 text-amber-800" },
};

export function MarketIntelligencePanel({
  data,
  isLoading,
  error,
}: {
  data: MarketIntelligence | undefined;
  isLoading: boolean;
  error: string | null;
}) {
  return (
    <Card className="mt-6">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2"><TrendingUp className="h-5 w-5 text-primary" /> Market Intelligence</CardTitle>
        {data && <Badge variant="outline">Updated {date(data.generated_at)}</Badge>}
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Gathering market data…</div>}
        {error && !isLoading && (
          <div className="flex items-start gap-2 rounded-md border border-amber-400/40 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> <span>Market data is unavailable right now: {error}</span>
          </div>
        )}

        {data && !isLoading && (
          <>
            {/* Market Summary — from VERIFIED SALES only */}
            <section>
              <h3 className="mb-2 text-sm font-semibold">Market Summary <span className="font-normal text-muted-foreground">· verified sales</span></h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Median sold" value={money(data.median_sold_cents)} />
                <Stat label="Last sold" value={money(data.last_sold_cents)} />
                <Stat label="Low sold" value={money(data.low_sold_cents)} />
                <Stat label="High sold" value={money(data.high_sold_cents)} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Verified sales" value={String(data.summary.count)} />
                <Stat label="Lowest active" value={money(data.lowest_active_cents)} hint="asking, not sold" />
                <Stat label="Liquidity" value={pct(data.liquidity)} icon={<Gauge className="h-3 w-3" />} />
                <Stat label="Confidence" value={pct(data.confidence)} />
              </div>
            </section>

            {/* Verified Sales */}
            <Section title="Verified Sales" count={data.verified_sales.length} empty="No verified completed sales yet.">
              {data.verified_sales.map((s, i) => (
                <Row key={i} title={s.title ?? "Sale"} sub={`${s.source} · sold ${date(s.sold_at)}`} value={money(s.price_cents)} url={s.url} />
              ))}
            </Section>

            {/* Current Listings — asking prices, clearly not sold */}
            <Section title="Current Listings" count={data.active_listings.length} empty="No active listings found." note="Asking prices — supply context, not sold evidence.">
              {data.active_listings.map((l, i) => (
                <Row key={i} title={l.title ?? "Listing"} sub={`${l.source} · asking`} value={money(l.price_cents)} url={l.url} />
              ))}
            </Section>

            {/* PriceCharting Grade Tiers — generic reference */}
            <Section title="PriceCharting Grade Tiers" count={data.grade_tiers.length} empty="No PriceCharting product matched.">
              {data.grade_tiers.map((t, i) => (
                <Row key={i} title={t.label ?? GRADE_TIER_LABELS[t.tier]} sub="pricecharting" value={money(t.value_cents)} />
              ))}
            </Section>

            {/* Provider Status — per-source health, so a failed/unconfigured
                provider is never rendered as "no market activity". */}
            <section>
              <h3 className="mb-2 text-sm font-semibold">Provider Status</h3>
              <div className="divide-y rounded-md border">
                {data.sources.map((s, i) => {
                  const meta = STATUS_META[s.status] ?? { label: s.status, cls: "border-muted bg-muted text-muted-foreground" };
                  return (
                    <div key={i} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span className="min-w-0 truncate font-medium">{SOURCE_LABEL[s.source] ?? s.source}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="hidden text-xs text-muted-foreground sm:inline">{s.message}</span>
                        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${meta.cls}`}>{meta.label}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
              {data.identity_completeness.status !== "complete" && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Identity {data.identity_completeness.status}
                  {data.identity_completeness.missing.length > 0 && <> · missing: {data.identity_completeness.missing.join(", ")}</>}
                  {" "}— match quality may be reduced, but market data is still shown.
                </p>
              )}
            </section>

            {/* Source and Last Updated */}
            <section className="border-t pt-3 text-xs text-muted-foreground">
              <p className="font-semibold">Sources</p>
              {data.provenance.length === 0 ? (
                <p>No sources responded.</p>
              ) : (
                data.provenance.map((p, i) => (
                  <p key={i}>{p.source}: {p.exact_count}/{p.candidate_count} exact · {date(p.retrieved_at)}</p>
                ))
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, hint, icon }: { label: string; value: string; hint?: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <p className="flex items-center gap-1 text-xs text-muted-foreground">{icon}{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Section({ title, count, empty, note, children }: { title: string; count: number; empty: string; note?: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold">{title} <Badge variant="outline" className="ml-1">{count}</Badge></h3>
      {note && <p className="mb-2 text-xs text-muted-foreground">{note}</p>}
      {count === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : <div className="divide-y rounded-md border">{children}</div>}
    </section>
  );
}

function Row({ title, sub, value, url }: { title: string; sub: string; value: string; url?: string | null }) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
      <div className="min-w-0">
        {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="truncate font-medium underline-offset-2 hover:underline">{title}</a> : <p className="truncate font-medium">{title}</p>}
        <p className="text-xs text-muted-foreground">{sub}</p>
      </div>
      <span className="shrink-0 font-semibold">{value}</span>
    </div>
  );
}
