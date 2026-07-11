import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHead } from "@/components/seo/PageHead";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/shared/LoadingState";
import { Download, Plus, Loader2 } from "lucide-react";
import { fetchAllSlabs, fetchAllComps } from "@/lib/slabs/data";
import { computeDashboardStats } from "@/lib/slabs/compute-stats";
import { formatCents } from "@/lib/slabs/format";

export default function SlabDashboard() {
  const [exporting, setExporting] = useState(false);
  const { data: slabs, isLoading } = useQuery({ queryKey: ["dashboard-slabs"], queryFn: fetchAllSlabs });

  const stats = slabs ? computeDashboardStats(slabs) : null;

  const handleExport = async () => {
    setExporting(true);
    try {
      const [allSlabs, comps, { downloadInventoryWorkbook }] = await Promise.all([
        fetchAllSlabs(),
        fetchAllComps(),
        import("@/lib/slabs/excel"),
      ]);
      await downloadInventoryWorkbook(allSlabs, comps);
      toast.success(`Exported ${allSlabs.length} slabs.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="container max-w-6xl py-8">
      <PageHead title="Dashboard · SlabVault" noindex />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">SlabVault Dashboard</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleExport} disabled={exporting}>
            {exporting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}
            Export Inventory
          </Button>
          <Button asChild><Link to="/slabs/new"><Plus className="mr-1 h-4 w-4" /> Add Slab</Link></Button>
          <Button variant="outline" asChild><Link to="/slabs">View Inventory</Link></Button>
        </div>
      </div>

      {isLoading || !stats ? (
        <LoadingState message="Loading dashboard..." />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Total Slabs" value={String(stats.total_slabs)} />
            <Stat label="Total Final Value" value={formatCents(stats.total_final_value_cents)} />
            <Stat label="Total Quick-Sale Value" value={formatCents(stats.total_quick_sale_value_cents)} />
            <Stat label="Total Replacement Value" value={formatCents(stats.total_replacement_value_cents)} />
            <Stat label="Average Slab Value" value={formatCents(stats.average_value_cents)} />
            <Stat label="Median Slab Value" value={formatCents(stats.median_value_cents)} />
            <Stat
              label="Highest-Value Slab"
              value={stats.highest_value_slab ? formatCents(stats.highest_value_slab.final_value_cents) : "—"}
              sub={stats.highest_value_slab ? `#${stats.highest_value_slab.inventory_number} ${stats.highest_value_slab.card_name ?? ""}` : undefined}
            />
            <Stat label="Needing Clearer Images" value={String(stats.count_needs_clearer_images)} />
            <Stat label="Possible Label Errors" value={String(stats.count_possible_label_errors)} />
            <Stat label="Duplicate Attempts" value={String(stats.count_duplicate_attempts)} />
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Breakdown title="By Grader" map={stats.count_by_grader} />
            <Breakdown title="By Grade" map={stats.count_by_grade} />
            <Breakdown title="By Language" map={stats.count_by_language} />
            <Breakdown title="By Confidence" map={stats.count_by_confidence} />
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-bold">{value}</p>
        {sub && <p className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function Breakdown({ title, map }: { title: string; map: Record<string, number> }) {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-1 text-sm">
        {entries.length === 0 ? (
          <p className="text-muted-foreground">No data.</p>
        ) : (
          entries.map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span className="text-muted-foreground">{k}</span>
              <span className="font-medium">{v}</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
