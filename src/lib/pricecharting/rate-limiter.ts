/**
 * Centralized rate limiter. NO request may reach PriceCharting except through
 * `applyRateLimit`, which serializes calls per bucket and enforces a minimum
 * interval between them. This makes it impossible for any function to
 * accidentally exceed PriceCharting's published limits.
 *
 * Buckets:
 *  - "standard": 1 req / sec (all normal API calls)
 *  - "csv":      1 req / 10 min
 *  - per-URL offers key: 1 req / 5 min for an identical /api/offers URL
 *
 * Requests within a bucket are FIFO-queued; we never fire concurrently within a
 * bucket, so parallelism can never breach a limit.
 */

import type { Clock } from "./clock";
import { RATE_LIMITS } from "./config";

interface Bucket {
  minIntervalMs: number;
  lastStartedAt: number; // epoch ms of the last granted slot (0 = never)
  chain: Promise<void>; // serializes waiters within the bucket
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly clock: Clock) {}

  private getBucket(key: string, minIntervalMs: number): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = { minIntervalMs, lastStartedAt: 0, chain: Promise.resolve() };
      this.buckets.set(key, b);
    }
    return b;
  }

  /**
   * Resolve the bucket key + interval for a logical request.
   *  - CSV → its own slow bucket.
   *  - /api/offers → per-URL bucket (5 min) AND still bound by the standard 1/s.
   *  - everything else → the shared "standard" 1/s bucket.
   *
   * For offers we chain through BOTH the per-URL bucket and the standard bucket
   * so neither limit can be violated.
   */
  async acquire(opts: { bucket: "standard" | "csv" | "offers"; urlKey?: string }): Promise<void> {
    if (opts.bucket === "csv") {
      await this.waitForBucket("csv", RATE_LIMITS.CSV_MIN_INTERVAL_MS);
      return;
    }
    if (opts.bucket === "offers") {
      // Per-URL 5-minute limit first, then the global 1/sec limit.
      const urlKey = `offers:${opts.urlKey ?? "default"}`;
      await this.waitForBucket(urlKey, RATE_LIMITS.OFFERS_PER_URL_MIN_INTERVAL_MS);
      await this.waitForBucket("standard", RATE_LIMITS.STANDARD_MIN_INTERVAL_MS);
      return;
    }
    await this.waitForBucket("standard", RATE_LIMITS.STANDARD_MIN_INTERVAL_MS);
  }

  /**
   * Serialize on the bucket's chain, then sleep until the min interval since the
   * previous grant has elapsed. Marking `lastStartedAt` BEFORE releasing the
   * chain guarantees the next waiter measures from this grant.
   */
  private waitForBucket(key: string, minIntervalMs: number): Promise<void> {
    const bucket = this.getBucket(key, minIntervalMs);

    const run = bucket.chain.then(async () => {
      const now = this.clock.now();
      const earliest = bucket.lastStartedAt === 0 ? now : bucket.lastStartedAt + bucket.minIntervalMs;
      const waitMs = Math.max(0, earliest - now);
      if (waitMs > 0) await this.clock.sleep(waitMs);
      bucket.lastStartedAt = this.clock.now();
    });

    // The next caller waits for this one to finish acquiring its slot.
    bucket.chain = run.catch(() => {
      /* keep the chain alive even if a waiter rejects */
    });
    return run;
  }

  /** Test/inspection helper: ms until this bucket would grant, 0 if immediate. */
  msUntilAvailable(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.lastStartedAt === 0) return 0;
    return Math.max(0, bucket.lastStartedAt + bucket.minIntervalMs - this.clock.now());
  }
}
