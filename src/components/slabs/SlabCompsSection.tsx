/**
 * Sales-comparable management for a slab: create / edit / delete comps, derived
 * statistics (exact-comp count + median, accepted median, sold range, most
 * recent sale), and an operator-APPROVED Final Value suggestion.
 *
 * PriceCharting is only ever shown as a secondary "guide value", never labeled
 * as a sold comp. The Final Value is never written without an explicit click.
 */

import { cloneElement, isValidElement, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Pencil, Trash2, Check } from "lucide-react";
import { fetchComps, insertComp, updateComp, deleteComp, updateSlab } from "@/lib/slabs/data";
import { formatCents, centsToInputString, dollarsToCents, todayLocalDate } from "@/lib/slabs/format";
import { computeCompStats, suggestFinalValue } from "@/lib/slabs/comps";
import type { Slab, SlabComp, SlabCompInput } from "@/lib/slabs/types";

const EMPTY_FORM = {
  sale_date: todayLocalDate(),
  sold: "",
  shipping: "",
  total: "",
  marketplace: "",
  grader: "",
  grade: "",
  exact_match: "no",
  source_url: "",
  notes: "",
};

function toInput(form: typeof EMPTY_FORM): SlabCompInput {
  return {
    sale_date: form.sale_date || null,
    sold_price_cents: dollarsToCents(form.sold),
    shipping_cents: dollarsToCents(form.shipping),
    total_price_cents: dollarsToCents(form.total),
    marketplace: form.marketplace.trim() || null,
    grader: form.grader.trim() || null,
    grade: form.grade.trim() || null,
    exact_match: form.exact_match === "yes",
    source_url: form.source_url.trim() || null,
    notes: form.notes.trim() || null,
  };
}

function fromComp(c: SlabComp): typeof EMPTY_FORM {
  return {
    sale_date: c.sale_date ?? "",
    sold: centsToInputString(c.sold_price_cents),
    shipping: centsToInputString(c.shipping_cents),
    total: centsToInputString(c.total_price_cents),
    marketplace: c.marketplace ?? "",
    grader: c.grader ?? "",
    grade: c.grade ?? "",
    exact_match: c.exact_match ? "yes" : "no",
    source_url: c.source_url ?? "",
    notes: c.notes ?? "",
  };
}

export function SlabCompsSection({ slab }: { slab: Slab }) {
  const queryClient = useQueryClient();
  const { data: comps } = useQuery({
    queryKey: ["slab-comps", slab.id],
    queryFn: () => fetchComps(slab.id),
  });

  const list = comps ?? [];
  const stats = computeCompStats(list);
  const suggestion = suggestFinalValue(stats, slab.pricecharting_value_cents);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["slab-comps", slab.id] });

  const remove = async (id: string) => {
    try {
      await deleteComp(id);
      toast.success("Comp deleted");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const approveFinalValue = async () => {
    if (suggestion.suggested_cents === null) return;
    try {
      await updateSlab(slab.id, {
        final_value_cents: suggestion.suggested_cents,
        valuation_confidence: suggestion.basis === "pricecharting_guide" ? "probable" : "high",
      });
      toast.success(`Final Value set to ${formatCents(suggestion.suggested_cents)}`);
      queryClient.invalidateQueries({ queryKey: ["slab", slab.id] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    }
  };

  return (
    <Card className="mt-6">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Sales Comps</CardTitle>
        <CompDialog slabId={slab.id} onSaved={refresh} trigger={
          <Button size="sm"><Plus className="mr-1 h-4 w-4" /> Add comp</Button>
        } />
      </CardHeader>
      <CardContent>
        {/* Derived statistics */}
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Exact comps" value={String(stats.exact_count)} />
          <Stat label="Exact median" value={formatCents(stats.exact_median_cents)} />
          <Stat label="Accepted median" value={formatCents(stats.accepted_median_cents)} />
          <Stat
            label="Sold range"
            value={stats.sold_range_cents ? `${formatCents(stats.sold_range_cents.min)} – ${formatCents(stats.sold_range_cents.max)}` : "—"}
          />
          <Stat label="Most recent sale" value={stats.most_recent_sale_date ?? "—"} />
        </div>

        {/* Operator-approved Final Value suggestion */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/20 p-3">
          <div>
            <p className="text-xs text-muted-foreground">Suggested Final Value</p>
            <p className="text-lg font-semibold">{formatCents(suggestion.suggested_cents)}</p>
            <p className="text-xs text-muted-foreground">{suggestion.rationale}</p>
          </div>
          <Button size="sm" variant="outline" onClick={approveFinalValue} disabled={suggestion.suggested_cents === null}>
            <Check className="mr-1 h-4 w-4" /> Approve as Final Value
          </Button>
        </div>

        {list.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead><TableHead>Sold</TableHead><TableHead>Shipping</TableHead>
                  <TableHead>Total</TableHead><TableHead>Marketplace</TableHead><TableHead>Grade</TableHead>
                  <TableHead>Exact</TableHead><TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.sale_date ?? "—"}</TableCell>
                    <TableCell>{formatCents(c.sold_price_cents)}</TableCell>
                    <TableCell>{formatCents(c.shipping_cents)}</TableCell>
                    <TableCell>{formatCents(c.total_price_cents)}</TableCell>
                    <TableCell>{c.marketplace ?? "—"}</TableCell>
                    <TableCell>{[c.grader, c.grade].filter(Boolean).join(" ") || "—"}</TableCell>
                    <TableCell>{c.exact_match === null ? "—" : c.exact_match ? "Yes" : "No"}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <CompDialog
                          slabId={slab.id}
                          comp={c}
                          onSaved={refresh}
                          trigger={<Button size="icon" variant="ghost" className="h-8 w-8"><Pencil className="h-4 w-4" /></Button>}
                        />
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => remove(c.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No sales comps recorded.</p>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Comps are real sold transactions. PriceCharting is a separate guide value, not a sold comp.
        </p>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border bg-background px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}

function CompDialog({
  slabId, comp, onSaved, trigger,
}: {
  slabId: string;
  comp?: SlabComp;
  onSaved: () => void;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(comp ? fromComp(comp) : EMPTY_FORM);
  const set = (k: keyof typeof EMPTY_FORM, v: string) => setForm((s) => ({ ...s, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      if (comp) await updateComp(comp.id, toInput(form));
      else await insertComp(slabId, toInput(form));
      toast.success(comp ? "Comp updated" : "Comp added");
      setOpen(false);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) setForm(comp ? fromComp(comp) : EMPTY_FORM); }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{comp ? "Edit comp" : "Add sales comp"}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <F label="Sale Date"><Input type="date" value={form.sale_date} onChange={(e) => set("sale_date", e.target.value)} /></F>
          <F label="Marketplace"><Input value={form.marketplace} onChange={(e) => set("marketplace", e.target.value)} placeholder="eBay, PWCC…" /></F>
          <F label="Sold Price ($)"><Input value={form.sold} onChange={(e) => set("sold", e.target.value)} inputMode="decimal" /></F>
          <F label="Shipping ($)"><Input value={form.shipping} onChange={(e) => set("shipping", e.target.value)} inputMode="decimal" /></F>
          <F label="Total ($, optional)"><Input value={form.total} onChange={(e) => set("total", e.target.value)} inputMode="decimal" placeholder="auto = sold + shipping" /></F>
          <F label="Exact Match">
            <ExactMatchSelect value={form.exact_match} onChange={(v) => set("exact_match", v)} />
          </F>
          <F label="Grader"><Input value={form.grader} onChange={(e) => set("grader", e.target.value)} /></F>
          <F label="Grade"><Input value={form.grade} onChange={(e) => set("grade", e.target.value)} /></F>
          <F label="Source URL" className="col-span-2"><Input value={form.source_url} onChange={(e) => set("source_url", e.target.value)} /></F>
          <F label="Notes" className="col-span-2"><Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} /></F>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? "Saving…" : comp ? "Save changes" : "Add comp"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function F({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      <Label htmlFor={id} className="text-xs">{label}</Label>
      {isValidElement(children) ? cloneElement(children as React.ReactElement<{ id?: string }>, { id }) : children}
    </div>
  );
}

/** Yes/No exact-match select that forwards the field id to its trigger for a11y. */
function ExactMatchSelect({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="yes">Yes — exact match</SelectItem>
        <SelectItem value="no">No — comparable</SelectItem>
      </SelectContent>
    </Select>
  );
}
