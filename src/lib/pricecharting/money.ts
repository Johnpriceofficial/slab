/**
 * Currency helpers. ALL money in this package is represented internally as
 * integer pennies. We never perform financial arithmetic in binary floating
 * point. Conversion to a dollar `number` happens only at the display boundary.
 *
 * PriceCharting returns monetary values as integer pennies:
 *   1732  -> $17.32
 *   10000 -> $100.00
 *   42995 -> $429.95
 */

/** Branded penny amount to discourage accidentally mixing dollars and pennies. */
export type Pennies = number;

/**
 * Convert integer pennies to a dollar number for USER-FACING output only.
 * Preserves `null` (missing data must never silently become 0).
 */
export function convertPenniesToDollars(pennies: Pennies | null | undefined): number | null {
  if (pennies === null || pennies === undefined) return null;
  if (!Number.isFinite(pennies)) {
    throw new Error(`convertPenniesToDollars: expected a finite number, got ${String(pennies)}`);
  }
  if (!Number.isInteger(pennies)) {
    throw new Error(`convertPenniesToDollars: pennies must be an integer, got ${pennies}`);
  }
  // Dividing an integer by 100 is exact for any |pennies| < 2^53, which covers
  // all realistic collectible values.
  return pennies / 100;
}

/**
 * Convert a dollar amount (number or string) to integer pennies WITHOUT binary
 * float rounding error. We parse the decimal representation directly.
 *
 * Accepts: 17.32, "17.32", "$1,299.95", 100, "0", ".5"
 */
export function convertDollarsToPennies(dollars: number | string | null | undefined): Pennies | null {
  if (dollars === null || dollars === undefined || dollars === "") return null;

  const raw = typeof dollars === "number" ? numberToDecimalString(dollars) : dollars.trim();

  // Strip currency symbols, thousands separators, and surrounding whitespace.
  const cleaned = raw.replace(/[\s$,]/g, "");
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) {
    throw new Error(`convertDollarsToPennies: cannot parse "${String(dollars)}" as a dollar amount`);
  }

  const sign = match[1] === "-" ? -1 : 1;
  const whole = match[2] === "" ? "0" : match[2];
  const fracRaw = match[3] ?? "";

  if (fracRaw.length > 2) {
    // More than 2 decimal places: round half-up on the 3rd digit rather than
    // silently truncating fractions of a cent.
    const centsPart = fracRaw.slice(0, 2).padEnd(2, "0");
    const roundDigit = Number(fracRaw[2]);
    let cents = Number(whole) * 100 + Number(centsPart);
    if (roundDigit >= 5) cents += 1;
    return sign * cents;
  }

  const frac = fracRaw.padEnd(2, "0");
  return sign * (Number(whole) * 100 + Number(frac));
}

/** Deterministic decimal string for a JS number (avoids "1e-7" style output). */
function numberToDecimalString(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`convertDollarsToPennies: expected a finite number, got ${String(n)}`);
  }
  // toFixed(4) then let the parser round to cents; enough precision for input
  // that originated as a currency figure.
  return n.toFixed(4);
}

/** Sum a list of penny amounts as integers. `null`/`undefined` entries are skipped. */
export function sumPennies(values: Array<Pennies | null | undefined>): Pennies {
  return values.reduce<number>((acc, v) => (v === null || v === undefined ? acc : acc + v), 0);
}

/** Multiply a penny unit price by an integer quantity (stays integer). */
export function multiplyPennies(unitPennies: Pennies, quantity: number): Pennies {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error(`multiplyPennies: quantity must be a non-negative integer, got ${quantity}`);
  }
  return unitPennies * quantity;
}

/** Format pennies as a USD string for logs/UI, e.g. 42995 -> "$429.95". */
export function formatPennies(pennies: Pennies | null | undefined): string {
  const dollars = convertPenniesToDollars(pennies);
  if (dollars === null) return "—";
  return `$${dollars.toFixed(2)}`;
}
