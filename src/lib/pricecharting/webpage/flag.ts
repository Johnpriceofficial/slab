/**
 * Feature flag for the public-page adapter. DISABLED by default: the adapter
 * performs NO network fetch unless PRICECHARTING_PAGE_ADAPTER_ENABLED === "true".
 * The env accessor is injected so this is pure and works in Node and Deno.
 *
 * Flipping this on in production is gated behind the Terms/operational review
 * (see docs/pricecharting-page-adapter.md). Turning it off instantly disables all
 * page requests with no code deploy.
 */

export type EnvGet = (name: string) => string | undefined;

export const PAGE_ADAPTER_FLAG = "PRICECHARTING_PAGE_ADAPTER_ENABLED";

/** True ONLY when the flag is explicitly the string "true". Anything else = off. */
export function pageAdapterEnabled(getEnv: EnvGet): boolean {
  return (getEnv(PAGE_ADAPTER_FLAG) ?? "").trim().toLowerCase() === "true";
}
