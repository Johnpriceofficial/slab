/**
 * Feature flag for the public-page adapter. DISABLED BY DEFAULT and explicitly
 * OPERATOR-CONTROLLED: the adapter performs NO network fetch unless
 * PRICECHARTING_PAGE_ADAPTER_ENABLED === "true". Turning it on in production is
 * gated behind the PriceCharting Terms / production-request-policy review (see
 * docs/pricecharting-page-adapter.md) — it must never default on silently.
 *
 * When the operator DOES enable it, the page becomes part of the canonical
 * confirmed-product workflow (fetched for every confirmed graded product for the
 * full grade table + reference artwork + tier corroboration). Setting anything
 * other than "true" (unset, "false", …) instantly disables all page requests with
 * no code deploy. The env accessor is injected so this is pure in Node and Deno.
 */

export type EnvGet = (name: string) => string | undefined;

export const PAGE_ADAPTER_FLAG = "PRICECHARTING_PAGE_ADAPTER_ENABLED";

/** True ONLY when the flag is explicitly the string "true". Anything else = off. */
export function pageAdapterEnabled(getEnv: EnvGet): boolean {
  return (getEnv(PAGE_ADAPTER_FLAG) ?? "").trim().toLowerCase() === "true";
}
