// Pure, cross-runtime definition of the eBay marketplace-mutation kill switches.
// The Edge function reads Deno.env; this module decides enabled/disabled so the
// default-off behavior and the "no bypass" property are unit-tested without Deno.

export const EBAY_MUTATION_FLAGS = {
  listing: "EBAY_LISTING_MUTATIONS_ENABLED",       // publish / revise / end
  fulfillment: "EBAY_FULFILLMENT_MUTATIONS_ENABLED", // shipping fulfillment
  financial: "EBAY_FINANCIAL_MUTATIONS_ENABLED",    // refunds (money movement)
  applySales: "EBAY_APPLY_SALES_ENABLED",           // mark local inventory sold
} as const;

export type EbayMutationFlag = keyof typeof EBAY_MUTATION_FLAGS;

/**
 * A mutation is enabled ONLY when its flag value is exactly "true"
 * (case-insensitive, trimmed). Undefined, empty, "false", "1", or anything else
 * is disabled. The flag VALUE is the sole input — no confirmation phrase or
 * request field is a parameter here, so a phrase can never bypass a disabled
 * flag. Defaults are therefore off.
 */
export function mutationEnabled(value: string | undefined | null): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}
