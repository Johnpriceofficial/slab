/**
 * Currency + value helpers for the slab UI. Integer-cents only; the only float
 * produced is at the display boundary. No binary-float money arithmetic.
 */

/**
 * Today's date as YYYY-MM-DD in the operator's LOCAL timezone. Date-only fields
 * (Date Valued, comp Sale Date) must NOT use `toISOString()` — that is UTC and
 * rolls to tomorrow on evenings west of UTC (e.g. EDT), showing the wrong day.
 */
export function todayLocalDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Cents → dollars number (e.g. 42995 → 429.95). Null-preserving. */
export function centsToDollars(cents: number | null | undefined): number | null {
  if (cents === null || cents === undefined) return null;
  if (!Number.isFinite(cents)) return null;
  return Math.round(cents) / 100;
}

/**
 * Dollars (string or number) → integer cents, parsed via the decimal string to
 * avoid float error. Returns null for empty input; throws on garbage.
 */
export function dollarsToCents(dollars: number | string | null | undefined): number | null {
  if (dollars === null || dollars === undefined || dollars === "") return null;
  const raw = typeof dollars === "number" ? dollars.toFixed(4) : dollars.trim();
  const cleaned = raw.replace(/[\s$,]/g, "");
  if (cleaned === "") return null;
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) {
    throw new Error(`dollarsToCents: cannot parse "${String(dollars)}"`);
  }
  const sign = m[1] === "-" ? -1 : 1;
  const whole = m[2] === "" ? 0 : Number(m[2]);
  const fracRaw = m[3] ?? "";
  if (fracRaw.length > 2) {
    const cents = whole * 100 + Number(fracRaw.slice(0, 2).padEnd(2, "0"));
    return sign * (Number(fracRaw[2]) >= 5 ? cents + 1 : cents);
  }
  return sign * (whole * 100 + Number(fracRaw.padEnd(2, "0")));
}

/** Cents → "$429.95" for display. Empty dash for null. */
export function formatCents(cents: number | null | undefined): string {
  const d = centsToDollars(cents);
  if (d === null) return "—";
  return d.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Cents → "429.95" plain, for editable inputs (no symbol). Empty string for null. */
export function centsToInputString(cents: number | null | undefined): string {
  const d = centsToDollars(cents);
  return d === null ? "" : d.toFixed(2);
}

/** File extension from a filename or mime type, lowercased, no dot. */
export function extensionFor(fileName: string, mime?: string): string {
  const fromName = fileName.includes(".") ? fileName.split(".").pop() : undefined;
  if (fromName) return fromName.toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
  };
  return (mime && map[mime]) || "jpg";
}
