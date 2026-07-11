/**
 * TTL response cache + in-flight duplicate-request suppression.
 *
 * - `get`/`set` provide read-through caching keyed by a canonical request key.
 * - `dedupe` collapses concurrent identical requests into a single upstream
 *   call (all callers await the same promise), preventing duplicate network hits.
 */

import type { Clock } from "./clock";

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class ResponseCache {
  private store = new Map<string, Entry<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly clock: Clock) {}

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key) as Entry<T> | undefined;
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.store.set(key, { value, expiresAt: this.clock.now() + ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }

  /**
   * Read-through with duplicate suppression. If a fresh cached value exists it
   * is returned. Otherwise, if an identical request is already in flight, its
   * promise is shared. Only the first caller triggers `loader`.
   */
  async dedupe<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;

    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const promise = (async () => {
      try {
        const value = await loader();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }
}
