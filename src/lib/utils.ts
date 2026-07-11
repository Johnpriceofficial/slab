import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format cents (integer) to a dollar display string.
 * e.g. 12500 → "$125.00", 0 → "$0.00"
 */
export function formatPrice(cents: number | null | undefined): string {
  if (cents == null || isNaN(cents)) return "$0.00";
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Convert cents to dollars number (for calculations that need the float).
 */
export function centsToDollars(cents: number | null | undefined): number {
  if (cents == null || isNaN(cents)) return 0;
  return cents / 100;
}
