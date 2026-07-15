/**
 * Public inventory identifiers (e.g. "S0001").
 *
 * The authoritative code is DB-generated and assigned server-side; these pure
 * helpers mirror that scheme for the browser — formatting a code for display and
 * parsing a search box entry so the UI can decide whether the operator typed an
 * ID ("S0001", "0001", "1") versus free text. The DB `resolve_slab_inventory`
 * RPC remains the ownership-scoped source of truth for turning a query into
 * rows; these never hit the network.
 */

export interface ParsedInventoryQuery {
  /** Single uppercase letter, or null when only a number was given. */
  prefix: string | null;
  sequence: number;
}

/** Zero-pad a sequence to at least `minDigits`; longer numbers pass through. */
export function formatInventoryCode(prefix: string, sequence: number, minDigits = 4): string {
  return `${prefix}${String(sequence).padStart(minDigits, "0")}`;
}

/**
 * Parse a search entry into a prefix + sequence, mirroring the SQL
 * parse_inventory_code:
 *   "S0001" -> { prefix: "S", sequence: 1 }
 *   "R0012" -> { prefix: "R", sequence: 12 }
 *   "0001"  -> { prefix: null, sequence: 1 }
 *   "1"     -> { prefix: null, sequence: 1 }
 * Anything else (free text, sequence 0, empty) returns null.
 */
export function parseInventoryQuery(query: string): ParsedInventoryQuery | null {
  const v = (query ?? "").trim().toUpperCase();
  const coded = v.match(/^([A-Z])(\d+)$/);
  if (coded) {
    const sequence = Number(coded[2]);
    return sequence >= 1 ? { prefix: coded[1], sequence } : null;
  }
  const numeric = v.match(/^(\d+)$/);
  if (numeric) {
    const sequence = Number(numeric[1]);
    return sequence >= 1 ? { prefix: null, sequence } : null;
  }
  return null;
}

/** True when the entry looks like an inventory ID rather than free-text search. */
export function isInventoryQuery(query: string): boolean {
  return parseInventoryQuery(query) !== null;
}
