/**
 * Injectable clock abstraction. Every time-dependent module (rate limiter,
 * retry/backoff, cache TTL) depends on this interface rather than the global
 * `Date`/`setTimeout`, so tests are fully deterministic.
 */

export interface Clock {
  /** Current epoch milliseconds. */
  now(): number;
  /** Resolve after `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
  /**
   * Deterministic 0..1 value for backoff jitter. Injected so tests can pin it.
   * (Math.random is intentionally NOT used directly anywhere in this package.)
   */
  random(): number;
}

/** Real clock backed by Date.now / setTimeout / Math.random. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

/**
 * Manual clock for tests: time only advances when `advance` is called, and
 * pending sleeps resolve once their deadline is reached. `random` is fixed.
 */
export class FakeClock implements Clock {
  private current: number;
  private fixedRandom: number;
  private pending: Array<{ at: number; resolve: () => void }> = [];

  constructor(startMs = 0, fixedRandom = 0.5) {
    this.current = startMs;
    this.fixedRandom = fixedRandom;
  }

  now(): number {
    return this.current;
  }

  random(): number {
    return this.fixedRandom;
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.pending.push({ at: this.current + ms, resolve });
    });
  }

  /** Advance simulated time and flush any sleeps whose deadline has passed. */
  async advance(ms: number): Promise<void> {
    this.current += ms;
    const due = this.pending.filter((p) => p.at <= this.current);
    this.pending = this.pending.filter((p) => p.at > this.current);
    for (const p of due) p.resolve();
    // Let microtasks (awaiting sleepers) run.
    await Promise.resolve();
  }

  setRandom(value: number): void {
    this.fixedRandom = value;
  }
}
