/**
 * Excel export (Phase 8). Builds a 3-sheet .xlsx workbook from database records:
 *   Sheet 1 — Master Inventory (exact 28-column order)
 *   Sheet 2 — Sales Comps
 *   Sheet 3 — Summary (dashboard totals)
 *
 * Requirements enforced here:
 *   - Frozen header row + auto-filter on every data sheet.
 *   - Currency formatting on money columns; money read from integer cents.
 *   - Certification numbers stored as TEXT (leading zeros preserved).
 *   - Inventory sorted numerically by inventory number.
 *   - Filename: SlabVault_Master_Inventory_YYYY-MM-DD.xlsx
 *
 * `buildInventoryWorkbook` is pure and synchronous-friendly for tests; the DOM
 * download helper is separate so tests never touch the browser.
 */

import ExcelJS from "exceljs";
import type { DashboardStats, Slab, SlabComp } from "./types";
import { EXCEL_COMPS_COLUMNS, EXCEL_MASTER_COLUMNS, type ColumnDef } from "./constants";
import { centsToDollars } from "./format";
import { computeDashboardStats } from "./compute-stats";

const CURRENCY_FMT = '$#,##0.00';
const PERCENT_FMT = '0.00"%"';
const TEXT_FMT = "@";

function dateOnly(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return String(iso).slice(0, 10);
}

/** Convert a slab field to a cell value in the correct primitive type. */
function masterCellValue(col: ColumnDef, slab: Slab): string | number | null {
  const raw = slab[col.key];
  switch (col.type) {
    case "currency":
      return centsToDollars(raw as number | null);
    case "percent":
      return raw === null || raw === undefined ? null : Number(raw);
    case "number":
      return raw === null || raw === undefined ? null : Number(raw);
    case "date":
      return dateOnly(raw as string | null);
    case "text":
    default:
      // Certification numbers MUST stay text (string) so leading zeros survive.
      return raw === null || raw === undefined ? null : String(raw);
  }
}

function applyHeaderAndFilter(ws: ExcelJS.Worksheet, columnCount: number): void {
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columnCount } };
}

/** Build the Master Inventory sheet. Rows sorted by inventory number ascending. */
function buildMasterSheet(wb: ExcelJS.Workbook, slabs: Slab[]): void {
  const ws = wb.addWorksheet("Master Inventory");
  ws.addRow(EXCEL_MASTER_COLUMNS.map((c) => c.label));

  const sorted = [...slabs].sort((a, b) => a.inventory_number - b.inventory_number);
  for (const slab of sorted) {
    const values = EXCEL_MASTER_COLUMNS.map((c) => masterCellValue(c, slab));
    const row = ws.addRow(values);
    // Force certification cells to be stored as explicit text.
    EXCEL_MASTER_COLUMNS.forEach((c, idx) => {
      if (c.key === "certification_number") {
        const cell = row.getCell(idx + 1);
        if (cell.value !== null && cell.value !== undefined) {
          cell.value = String(cell.value);
        }
        cell.numFmt = TEXT_FMT;
      }
    });
  }

  // Column-level number formats.
  EXCEL_MASTER_COLUMNS.forEach((c, idx) => {
    const column = ws.getColumn(idx + 1);
    column.width = Math.max(10, Math.min(40, c.label.length + 4));
    if (c.type === "currency") column.numFmt = CURRENCY_FMT;
    else if (c.type === "percent") column.numFmt = PERCENT_FMT;
    else if (c.key === "certification_number") column.numFmt = TEXT_FMT;
  });

  applyHeaderAndFilter(ws, EXCEL_MASTER_COLUMNS.length);
}

function buildCompsSheet(wb: ExcelJS.Workbook, comps: SlabComp[]): void {
  const ws = wb.addWorksheet("Sales Comps");
  ws.addRow(EXCEL_COMPS_COLUMNS.map((c) => c.label));

  for (const comp of comps) {
    const values = EXCEL_COMPS_COLUMNS.map((c) => {
      const raw = comp[c.key];
      if (c.type === "currency") return centsToDollars(raw as number | null);
      if (c.type === "date") return dateOnly(raw as string | null);
      if (c.key === "exact_match") return raw === null || raw === undefined ? null : raw ? "Yes" : "No";
      return raw === null || raw === undefined ? null : String(raw);
    });
    ws.addRow(values);
  }

  EXCEL_COMPS_COLUMNS.forEach((c, idx) => {
    const column = ws.getColumn(idx + 1);
    column.width = Math.max(10, Math.min(40, c.label.length + 4));
    if (c.type === "currency") column.numFmt = CURRENCY_FMT;
  });

  applyHeaderAndFilter(ws, EXCEL_COMPS_COLUMNS.length);
}

function buildSummarySheet(wb: ExcelJS.Workbook, stats: DashboardStats): void {
  const ws = wb.addWorksheet("Summary");
  ws.addRow(["Metric", "Value"]);

  const money = (c: number | null) => (c === null ? "—" : centsToDollars(c));
  const addMetric = (label: string, value: string | number | null, currency = false) => {
    const row = ws.addRow([label, value]);
    if (currency) row.getCell(2).numFmt = CURRENCY_FMT;
    return row;
  };

  addMetric("Total Slabs", stats.total_slabs);
  addMetric("Total Final Value", money(stats.total_final_value_cents), true);
  addMetric("Total Quick-Sale Value", money(stats.total_quick_sale_value_cents), true);
  addMetric("Total Replacement Value", money(stats.total_replacement_value_cents), true);
  addMetric("Average Slab Value", money(stats.average_value_cents), true);
  addMetric("Median Slab Value", money(stats.median_value_cents), true);
  addMetric(
    "Highest-Value Slab",
    stats.highest_value_slab
      ? `#${stats.highest_value_slab.inventory_number} — ${stats.highest_value_slab.card_name ?? "?"}`
      : "—",
  );
  addMetric("Highest-Value Amount", stats.highest_value_slab ? centsToDollars(stats.highest_value_slab.final_value_cents) : "—", true);
  addMetric("Needing Clearer Images", stats.count_needs_clearer_images);
  addMetric("Possible Label Errors", stats.count_possible_label_errors);
  addMetric("Duplicate Attempts", stats.count_duplicate_attempts);

  const addBreakdown = (title: string, map: Record<string, number>) => {
    ws.addRow([]);
    ws.addRow([title, ""]).getCell(1).font = { bold: true };
    for (const [k, v] of Object.entries(map).sort()) ws.addRow([k, v]);
  };
  addBreakdown("Count by Grader", stats.count_by_grader);
  addBreakdown("Count by Grade", stats.count_by_grade);
  addBreakdown("Count by Language", stats.count_by_language);
  addBreakdown("Count by Confidence", stats.count_by_confidence);

  ws.getColumn(1).width = 28;
  ws.getColumn(2).width = 24;
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

/** Build the complete workbook. `stats` is derived from `slabs` when omitted. */
export function buildInventoryWorkbook(
  slabs: Slab[],
  comps: SlabComp[],
  stats?: DashboardStats,
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "SlabVault";
  buildMasterSheet(wb, slabs);
  buildCompsSheet(wb, comps);
  buildSummarySheet(wb, stats ?? computeDashboardStats(slabs));
  return wb;
}

/** Deterministic workbook filename for a given date. */
export function workbookFilename(today: Date = new Date()): string {
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  return `SlabVault_Master_Inventory_${y}-${m}-${d}.xlsx`;
}

/** Browser-only: build the workbook and trigger a download. */
export async function downloadInventoryWorkbook(
  slabs: Slab[],
  comps: SlabComp[],
  stats?: DashboardStats,
): Promise<void> {
  const wb = buildInventoryWorkbook(slabs, comps, stats);
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = workbookFilename();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
