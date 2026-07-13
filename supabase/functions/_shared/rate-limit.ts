import { createClient } from "npm:@supabase/supabase-js@2.110.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** PriceCharting's published limit: at most 1 request per second. */
const PRICECHARTING_MIN_INTERVAL_MS = 1000;
/** Max time we'll wait for a reserved slot before giving up (fail closed). */
const MAX_WAIT_MS = 10_000;

/** Thrown when a durable reservation cannot be obtained; the handler maps this
 *  to a non-retryable 503 and NEVER calls PriceCharting. */
export class ReservationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReservationUnavailableError";
  }
}

/**
 * Reserve a durable, global PriceCharting request slot in the database and wait
 * until it. Every isolate/request goes through the same counter, so concurrent
 * callers and retries are spaced ≥1s apart no matter how many isolates are warm.
 *
 * FAIL CLOSED: the durable reservation is the AUTHORITATIVE gate. If it errors,
 * returns no slot, or the reserved wait exceeds the cap, this THROWS — the
 * client turns that into a non-retryable 503 and does not contact PriceCharting.
 * The in-memory limiter remains only as a secondary safeguard; it does not
 * substitute for the database reservation.
 *
 * Suitable for `HandlerDeps.beforeRequest`: awaited before every network attempt
 * (including retries), each reserving a fresh slot.
 */
export function makePriceChartingReserver(): (endpoint: string) => Promise<void> {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  return async () => {
    let data: unknown;
    let error: { message?: string } | null;
    try {
      ({ data, error } = await admin.rpc("reserve_api_request_slot", {
        p_bucket: "pricecharting",
        p_min_interval_ms: PRICECHARTING_MIN_INTERVAL_MS,
      }));
    } catch (e) {
      throw new ReservationUnavailableError(
        `rate-limit reservation call failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (error || !data) {
      throw new ReservationUnavailableError(`rate-limit reservation unavailable: ${error?.message ?? "no slot returned"}`);
    }
    const reservedAtMs = new Date(data as string).getTime();
    const waitMs = reservedAtMs - Date.now();
    if (waitMs > MAX_WAIT_MS) {
      // Queue is backed up beyond our cap — refuse rather than risk an unspaced call.
      throw new ReservationUnavailableError(`reserved wait ${waitMs}ms exceeds cap ${MAX_WAIT_MS}ms`);
    }
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  };
}
