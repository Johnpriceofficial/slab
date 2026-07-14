import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHead } from "@/components/seo/PageHead";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LoadingState } from "@/components/shared/LoadingState";
import { useAuth } from "@/auth/AuthProvider";
import { Plus, Download, ArrowUpDown, Loader2 } from "lucide-react";
import { INVENTORY_TABLE_COLUMNS, GRADERS, LANGUAGES, VERIFICATION_STATUSES, DUPLICATE_STATUSES } from "@/lib/slabs/constants";
import { fetchSlabs, fetchAllSlabs, fetchAllComps, type SlabQuery } from "@/lib/slabs/data";
import { formatCents, dollarsToCents } from "@/lib/slabs/format";
import type { Slab } from "@/lib/slabs/types";

const PAGE_SIZE = 50;
const ANY = "__any__";

function renderCell(slab: Slab, col: (typeof INVENTORY_TABLE_COLUMNS)[number]): React.ReactNode {
  const raw = slab[col.key];
  if (col.type === "currency") return formatCents(raw as number | null);
  if (col.type === "date") return raw ? String(raw).slice(0, 10) : "—";
  if (raw === null || raw === undefined || raw === "") return "—";
  return String(raw);
}

export default function SlabList() {
  const { status } = useAuth();
  const isAdmin = status === "admin";
  const [search, setSearch] = useState("");
  const [grader, setGrader] = useState("");
  const [grade, setGrade] = useState("");
  const [language, setLanguage] = useState("");
  const [verification, setVerification] = useState("");
  const [duplicate, setDuplicate] = useState("");
  const [minVal, setMinVal] = useState("");
  const [maxVal, setMaxVal] = useState("");
  const [sortKey, setSortKey] = useState<keyof Slab>("inventory_number");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);

  const query: SlabQuery = useMemo(
    () => ({
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
    }),
    [search, grader, grade, language, verification, duplicate, minVal, maxVal, includeArchived, sortKey, sortDir, page],
  );

  const { data, isLoading } = useQuery({
    queryKey: ["slabs", query],
    queryFn: () => fetchSlabs(query),
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggleSort = (key: keyof Slab) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
    setPage(0);
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const [slabs, comps, { downloadInventoryWorkbook }] = await Promise.all([
        fetchAllSlabs(),
        fetchAllComps(),
        import("@/lib/slabs/excel"),
      ]);
      await downloadInventoryWorkbook(slabs, comps);
      toast.success(`Exported ${slabs.length} slabs to Excel.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const distinctGrades = ["9", "9.5", "10", "8", "8.5", "7"];

  return (
    <div className="container max-w-[1400px] py-8">
      <PageHead title="Graded Card Inventory · GradedCardValue.com" noindex />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{isAdmin ? "Slab Inventory" : "My Slabs"}</h1>
          <p className="text-sm text-muted-foreground">{total} slabs</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={includeArchived ? "secondary" : "outline"}
            onClick={() => { setIncludeArchived((v) => !v); setPage(0); }}
          >
            {includeArchived ? "Hide archived" : "Show archived"}
          </Button>
          {/* Excel export is an administrative bulk tool. */}
          {isAdmin && (
            <Button variant="outline" onClick={handleExport} disabled={exporting}>
              {exporting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}
              Export Inventory
            </Button>
          )}
          <Button asChild>
            <Link to="/slabs/new">
              <Plus className="mr-1 h-4 w-4" /> Add Slab
            </Link>
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Input
          placeholder="Search name, cert, set, card #"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
        <FilterSelect placeholder="Any grader" value={grader} onChange={(v) => { setGrader(v); setPage(0); }} options={GRADERS.map((g) => ({ value: g, label: g }))} />
        <FilterSelect placeholder="Any grade" value={grade} onChange={(v) => { setGrade(v); setPage(0); }} options={distinctGrades.map((g) => ({ value: g, label: g }))} />
        <FilterSelect placeholder="Any language" value={language} onChange={(v) => { setLanguage(v); setPage(0); }} options={LANGUAGES.map((l) => ({ value: l, label: l }))} />
        <FilterSelect placeholder="Any verification" value={verification} onChange={(v) => { setVerification(v); setPage(0); }} options={VERIFICATION_STATUSES.map((s) => ({ value: s.value, label: s.label }))} />
        <FilterSelect placeholder="Any duplicate status" value={duplicate} onChange={(v) => { setDuplicate(v); setPage(0); }} options={DUPLICATE_STATUSES.map((s) => ({ value: s.value, label: s.label }))} />
        <Input placeholder="Min value ($)" value={minVal} onChange={(e) => { setMinVal(e.target.value); setPage(0); }} inputMode="decimal" />
        <Input placeholder="Max value ($)" value={maxVal} onChange={(e) => { setMaxVal(e.target.value); setPage(0); }} inputMode="decimal" />
      </div>

      {isLoading ? (
        <LoadingState message="Loading inventory..." />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                {INVENTORY_TABLE_COLUMNS.map((col) => (
                  <TableHead key={String(col.key)} className="whitespace-nowrap">
                    <button className="flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort(col.key)}>
                      {col.label}
                      <ArrowUpDown className="h-3 w-3 opacity-50" />
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={INVENTORY_TABLE_COLUMNS.length} className="py-10 text-center text-muted-foreground">
                    No slabs yet. <Link to="/slabs/new" className="underline">Add your first slab.</Link>
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((slab) => (
                  <TableRow key={slab.id} className="cursor-pointer">
                    {INVENTORY_TABLE_COLUMNS.map((col, i) => (
                      <TableCell key={String(col.key)} className="whitespace-nowrap">
                        {i === 0 ? (
                          <Link to={`/slabs/${slab.id}`} className="font-medium text-primary hover:underline">
                            {renderCell(slab, col)}
                          </Link>
                        ) : col.key === "pricecharting_match_status" && slab.pricecharting_match_status ? (
                          <Badge variant="outline">{slab.pricecharting_match_status}</Badge>
                        ) : (
                          renderCell(slab, col)
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Pagination */}
      <div className="mt-4 flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          Page {page + 1} of {pageCount}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

function FilterSelect({
  placeholder,
  value,
  onChange,
  options,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <Select value={value || ANY} onValueChange={(v) => onChange(v === ANY ? "" : v)}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{placeholder}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
