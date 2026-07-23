import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHead } from "@/components/seo/PageHead";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LoadingState } from "@/components/shared/LoadingState";
import { useAuth } from "@/auth/AuthProvider";
import { Plus, Download, ArrowDown, ArrowUp, ArrowUpDown, Loader2, Trash2, RefreshCw } from "lucide-react";
import { INVENTORY_TABLE_COLUMNS, GRADERS, LANGUAGES, VERIFICATION_STATUSES, DUPLICATE_STATUSES } from "@/lib/slabs/constants";
import { fetchSlabs, fetchAllSlabs, fetchAllComps, type SlabQuery } from "@/lib/slabs/data";
import {
  fetchPermanentDeleteEnabled,
  purgeSlabs,
  retryPendingSlabStorageCleanup,
  setPermanentDeleteEnabled,
} from "@/lib/slabs/inventory-maintenance";
import { formatCents, dollarsToCents } from "@/lib/slabs/format";
import { guideValueSourceMarker } from "@/lib/slabs/valuation-provenance";
import type { Slab } from "@/lib/slabs/types";

const PAGE_SIZE = 50;
const ANY = "__any__";

function renderCell(slab: Slab, col: (typeof INVENTORY_TABLE_COLUMNS)[number]): React.ReactNode {
  const raw = slab[col.key];
  if (col.type === "currency") {
    const formatted = formatCents(raw as number | null);
    if (col.key === "pricecharting_value_cents" && raw != null) {
      const marker = guideValueSourceMarker(slab.valuation_provenance);
      if (marker) return <span>{formatted} <span className="text-xs text-muted-foreground">({marker})</span></span>;
    }
    return formatted;
  }
  if (col.type === "date") return raw ? String(raw).slice(0, 10) : "—";
  if (raw === null || raw === undefined || raw === "") return "—";
  return String(raw);
}

export default function SlabList() {
  const { status } = useAuth();
  const isAdmin = status === "admin";
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [grader, setGrader] = useState("");
  const [grade, setGrade] = useState("");
  const [language, setLanguage] = useState("");
  const [verification, setVerification] = useState("");
  const [duplicate, setDuplicate] = useState("");
  const [minVal, setMinVal] = useState("");
  const [maxVal, setMaxVal] = useState("");
  const [sortKey, setSortKey] = useState<keyof Slab>("inventory_sequence");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);

  const query: SlabQuery = useMemo(() => ({
    search,
    grader: grader || undefined,
    grade: grade || undefined,
    language: language || undefined,
    verification_status: verification || undefined,
    duplicate_status: duplicate || undefined,
    minValueCents: minVal ? dollarsToCents(minVal) : null,
    maxValueCents: maxVal ? dollarsToCents(maxVal) : null,
    includeArchived,
    sortKey,
    sortDir,
    page,
    pageSize: PAGE_SIZE,
  }), [search, grader, grade, language, verification, duplicate, minVal, maxVal, includeArchived, sortKey, sortDir, page]);

  const { data, isLoading } = useQuery({ queryKey: ["slabs", query], queryFn: () => fetchSlabs(query) });
  const { data: permanentDeleteEnabled = false } = useQuery({
    queryKey: ["slab-settings", "allow-hard-delete"],
    queryFn: fetchPermanentDeleteEnabled,
    enabled: isAdmin,
  });
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const selectedRows = rows.filter((row) => selected.has(row.id));
  const allPageSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));

  const resetSelection = () => setSelected(new Set());

  const refreshInventory = async () => {
    resetSelection();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["slabs"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard-slabs"] }),
    ]);
  };

  const toggleSort = (key: keyof Slab) => {
    if (sortKey === key) setSortDir((direction) => direction === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
    setPage(0);
    resetSelection();
  };

  const sortIcon = (key: keyof Slab) => {
    if (sortKey !== key) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  };

  const toggleRow = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const togglePage = () => setSelected((current) => {
    const next = new Set(current);
    if (allPageSelected) rows.forEach((row) => next.delete(row.id));
    else rows.forEach((row) => next.add(row.id));
    return next;
  });

  const togglePermanentDelete = async (enabled: boolean) => {
    if (enabled && !window.confirm("Enable permanent deletion? This unlocks irreversible database purges for slabs.")) return;
    setMaintenanceBusy(true);
    try {
      await setPermanentDeleteEnabled(enabled);
      await queryClient.invalidateQueries({ queryKey: ["slab-settings", "allow-hard-delete"] });
      toast.success(enabled ? "Permanent deletion enabled." : "Permanent deletion disabled.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Delete setting could not be changed.");
    } finally { setMaintenanceBusy(false); }
  };

  const retryStorageCleanup = async () => {
    setMaintenanceBusy(true);
    try {
      const result = await retryPendingSlabStorageCleanup();
      if (result.pending > 0) {
        toast.warning(`${result.pending} stored image(s) remain queued for retry: ${result.errors.join("; ")}`);
      } else if (result.removed > 0) {
        toast.success(`${result.removed} queued stored image(s) removed.`);
      } else {
        toast.success("No pending stored-image cleanup.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Stored-image cleanup could not be retried.");
    } finally { setMaintenanceBusy(false); }
  };

  const confirmAndPurge = async (targets: Slab[], label: string) => {
    if (targets.length === 0) return;
    const archivedCount = targets.filter((row) => !!row.archived_at).length;
    const activeCount = targets.length - archivedCount;
    const warning = [
      `Permanently delete ${label}?`,
      `${targets.length} slab(s): ${archivedCount} archived; ${activeCount} active.`,
      "This removes database records and stored images. Failed image removals remain in a durable retry queue.",
      "External backups, provider records, or platform infrastructure logs are outside this application's purge boundary.",
    ].join("\n\n");
    if (!window.confirm(warning)) return;
    const confirmation = targets.length === 1 ? "DELETE 1" : `DELETE ${targets.length}`;
    const typed = window.prompt(`Type ${confirmation} to confirm.`);
    if (typed !== confirmation) {
      toast.error("Permanent deletion cancelled: confirmation text did not match.");
      return;
    }
    setMaintenanceBusy(true);
    try {
      const result = await purgeSlabs(targets.map((row) => row.id));
      if (result.storageCleanup.pending > 0) {
        toast.warning(`${result.purged} record(s) purged. ${result.storageCleanup.pending} image(s) are safely queued for retry: ${result.storageCleanup.errors.join("; ")}`);
      } else {
        toast.success(`${result.purged} slab(s) and associated stored images permanently purged.`);
      }
      await refreshInventory();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Slabs could not be purged.");
    } finally { setMaintenanceBusy(false); }
  };

  const purgeSelected = () => confirmAndPurge(selectedRows, `${selectedRows.length} selected slab(s)`);
  const purgeOne = (slab: Slab) => confirmAndPurge([slab], slab.inventory_code ?? "this slab");

  const purgeAll = async () => {
    setMaintenanceBusy(true);
    try {
      const allSlabs = await fetchAllSlabs();
      setMaintenanceBusy(false);
      await confirmAndPurge(allSlabs, `ALL ${allSlabs.length} slabs in the inventory`);
    } catch (error) {
      setMaintenanceBusy(false);
      toast.error(error instanceof Error ? error.message : "The complete inventory could not be loaded.");
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const [slabs, comps, { downloadInventoryWorkbook }] = await Promise.all([fetchAllSlabs(), fetchAllComps(), import("@/lib/slabs/excel")]);
      await downloadInventoryWorkbook(slabs, comps);
      toast.success(`Exported ${slabs.length} slabs to Excel.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed");
    } finally { setExporting(false); }
  };

  const distinctGrades = ["9", "9.5", "10", "8", "8.5", "7"];
  const resetPageAndSelection = () => { setPage(0); resetSelection(); };

  return (
    <div className="container max-w-[1600px] py-8">
      <PageHead title="Graded Card Inventory · GradedCardValue.com" noindex />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-bold">{isAdmin ? "Slab Inventory" : "My Slabs"}</h1><p className="text-sm text-muted-foreground">{total} slabs</p></div>
        <div className="flex flex-wrap gap-2">
          <Button variant={includeArchived ? "secondary" : "outline"} onClick={() => { setIncludeArchived((value) => !value); resetPageAndSelection(); }}>{includeArchived ? "Hide archived" : "Show archived"}</Button>
          {isAdmin && <Button variant="outline" onClick={handleExport} disabled={exporting}>{exporting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}Export Inventory</Button>}
          <Button asChild><Link to="/slabs/new"><Plus className="mr-1 h-4 w-4" /> Add Slab</Link></Button>
        </div>
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Input placeholder="Search name, cert, set, card #, or ID" value={search} onChange={(event) => { setSearch(event.target.value); resetPageAndSelection(); }} />
        <FilterSelect placeholder="Any grader" value={grader} onChange={(value) => { setGrader(value); resetPageAndSelection(); }} options={GRADERS.map((value) => ({ value, label: value }))} />
        <FilterSelect placeholder="Any grade" value={grade} onChange={(value) => { setGrade(value); resetPageAndSelection(); }} options={distinctGrades.map((value) => ({ value, label: value }))} />
        <FilterSelect placeholder="Any language" value={language} onChange={(value) => { setLanguage(value); resetPageAndSelection(); }} options={LANGUAGES.map((value) => ({ value, label: value }))} />
        <FilterSelect placeholder="Any verification" value={verification} onChange={(value) => { setVerification(value); resetPageAndSelection(); }} options={VERIFICATION_STATUSES.map((value) => ({ value: value.value, label: value.label }))} />
        <FilterSelect placeholder="Any duplicate status" value={duplicate} onChange={(value) => { setDuplicate(value); resetPageAndSelection(); }} options={DUPLICATE_STATUSES.map((value) => ({ value: value.value, label: value.label }))} />
        <Input placeholder="Min value ($)" value={minVal} onChange={(event) => { setMinVal(event.target.value); resetPageAndSelection(); }} inputMode="decimal" />
        <Input placeholder="Max value ($)" value={maxVal} onChange={(event) => { setMaxVal(event.target.value); resetPageAndSelection(); }} inputMode="decimal" />
      </div>

      {isAdmin && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={permanentDeleteEnabled} disabled={maintenanceBusy} onChange={(event) => void togglePermanentDelete(event.target.checked)} />
            Enable permanent deletion
          </label>
          <span className="mr-auto text-xs text-muted-foreground">Database safety switch. Turn it off after cleanup.</span>
          <span className="text-sm"><strong>{selectedRows.length}</strong> selected on this page</span>
          <Button variant="outline" size="sm" onClick={() => void retryStorageCleanup()} disabled={maintenanceBusy}><RefreshCw /> Retry image cleanup</Button>
          <Button variant="destructive" size="sm" onClick={() => void purgeSelected()} disabled={maintenanceBusy || !permanentDeleteEnabled || selectedRows.length === 0}><Trash2 /> Delete selected</Button>
          <Button variant="destructive" size="sm" onClick={() => void purgeAll()} disabled={maintenanceBusy || !permanentDeleteEnabled || total === 0}><Trash2 /> Delete all slabs</Button>
        </div>
      )}

      {isLoading ? <LoadingState message="Loading inventory..." /> : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader><TableRow>
              {isAdmin && <TableHead className="w-10"><input type="checkbox" aria-label="Select all slabs on this page" checked={allPageSelected} onChange={togglePage} /></TableHead>}
              {INVENTORY_TABLE_COLUMNS.map((column) => <TableHead key={String(column.key)} className="whitespace-nowrap"><button type="button" className="flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort(column.key)} aria-label={`Sort by ${column.label}`}>{column.label}{sortIcon(column.key)}</button></TableHead>)}
              {isAdmin && <TableHead className="whitespace-nowrap">Admin</TableHead>}
            </TableRow></TableHeader>
            <TableBody>
              {rows.length === 0 ? <TableRow><TableCell colSpan={INVENTORY_TABLE_COLUMNS.length + (isAdmin ? 2 : 0)} className="py-10 text-center text-muted-foreground">No slabs yet. <Link to="/slabs/new" className="underline">Add your first slab.</Link></TableCell></TableRow> : rows.map((slab) => (
                <TableRow key={slab.id} data-state={selected.has(slab.id) ? "selected" : undefined}>
                  {isAdmin && <TableCell><input type="checkbox" aria-label={`Select ${slab.inventory_code}`} checked={selected.has(slab.id)} onChange={() => toggleRow(slab.id)} /></TableCell>}
                  {INVENTORY_TABLE_COLUMNS.map((column, index) => <TableCell key={String(column.key)} className="whitespace-nowrap">{index === 0 ? <Link to={`/slabs/${slab.id}`} className="font-medium text-primary hover:underline">{renderCell(slab, column)}</Link> : column.key === "pricecharting_match_status" && slab.pricecharting_match_status ? <Badge variant="outline">{slab.pricecharting_match_status}</Badge> : renderCell(slab, column)}</TableCell>)}
                  {isAdmin && <TableCell><Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => void purgeOne(slab)} disabled={maintenanceBusy || !permanentDeleteEnabled}><Trash2 className="h-4 w-4" /> Delete</Button></TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between"><span className="text-sm text-muted-foreground">Page {page + 1} of {pageCount}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={page === 0} onClick={() => { setPage((value) => Math.max(0, value - 1)); resetSelection(); }}>Previous</Button><Button variant="outline" size="sm" disabled={page + 1 >= pageCount} onClick={() => { setPage((value) => value + 1); resetSelection(); }}>Next</Button></div></div>
    </div>
  );
}

function FilterSelect({ placeholder, value, onChange, options }: { placeholder: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return <Select value={value || ANY} onValueChange={(next) => onChange(next === ANY ? "" : next)}><SelectTrigger><SelectValue placeholder={placeholder} /></SelectTrigger><SelectContent><SelectItem value={ANY}>{placeholder}</SelectItem>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>;
}
