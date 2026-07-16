/**
 * Feature flag for the public-page adapter. ENABLED BY DEFAULT — the confirmed
 * product page is part of the canonical valuation/artwork workflow, not an opt-in
 * extra. Only an explicit emergency KILL SWITCH disables it, with no code deploy:
 *
 *   PRICECHARTING_PAGE_ADAPTER_ENABLED=false   (also: 0 / off / no / disabled)
 *
 * Any other value — unset, "true", empty — leaves the adapter ON. The env accessor
 * is injected so this is pure and works in Node and Deno.
 */

export type EnvGet = (name: string) => string | undefined;

export const PAGE_ADAPTER_FLAG = "PRICECHARTING_PAGE_ADAPTER_ENABLED";

/** The explicit kill-switch values that turn the adapter OFF. */
const KILL_VALUES: ReadonlySet<string> = new Set(["false", "0", "off", "no", "disabled"]);

/** True unless the flag is explicitly set to a kill-switch value. Default = ON. */
export function pageAdapterEnabled(getEnv: EnvGet): boolean {
  return !KILL_VALUES.has((getEnv(PAGE_ADAPTER_FLAG) ?? "").trim().toLowerCase());
}
