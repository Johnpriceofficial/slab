/**
 * Shared test helpers for the PriceCharting suite: a programmable mock fetch and
 * a deterministic recording clock. Not a test file (no .test suffix) so vitest
 * does not execute it as a suite.
 */

import type { Clock } from "@/lib/pricecharting/clock";
import type { FetchLike } from "@/lib/pricecharting/client";

export interface MockResponse {
  status?: number;
  json?: unknown;
  text?: string;
  /** Throw a transport error instead of responding (network failure / abort). */
  networkError?: { name?: string; message?: string };
}

export interface MockFetch {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; method: string }>;
  /**
   * Queue one or more responses for URLs containing `key`. When multiple are
   * queued they are consumed in order; the final one persists for later calls.
   */
  enqueue(key: string, ...responses: MockResponse[]): void;
}

export function createMockFetch(): MockFetch {
  const queues = new Map<string, MockResponse[]>();
  const calls: Array<{ url: string; method: string }> = [];

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    for (const [key, q] of queues) {
      if (url.includes(key) && q.length > 0) {
        const r = q.length > 1 ? (q.shift() as MockResponse) : q[0];
        if (r.networkError) {
          const err = new Error(r.networkError.message ?? "network error");
          err.name = r.networkError.name ?? "TypeError";
          throw err;
        }
        const status = r.status ?? 200;
        const text = r.text ?? JSON.stringify(r.json ?? {});
        return {
          ok: status >= 200 && status < 300,
          status,
          text: async () => text,
        };
      }
    }
    throw new Error(`No mock response registered for URL: ${url}`);
  };

  return {
    fetchImpl,
    calls,
    enqueue(key, ...responses) {
      const existing = queues.get(key) ?? [];
      queues.set(key, existing.concat(responses));
    },
  };
}

/**
 * Deterministic clock. `sleep(ms)` resolves immediately but advances virtual
 * time by `ms`, so rate-limit spacing and retry backoff are enforced logically
 * (and recorded in `sleeps`) without any real wall-clock delay.
 */
export class RecordingClock implements Clock {
  private t: number;
  private rnd: number;
  readonly sleeps: number[] = [];

  constructor(startMs = 1_000_000, fixedRandom = 0.5) {
    this.t = startMs;
    this.rnd = fixedRandom;
  }
  now(): number {
    return this.t;
  }
  random(): number {
    return this.rnd;
  }
  sleep(ms: number): Promise<void> {
    if (ms > 0) {
      this.sleeps.push(ms);
      this.t += ms;
    }
    return Promise.resolve();
  }
  setRandom(v: number): void {
    this.rnd = v;
  }
}

/** A raw product record with sensible defaults; override any field. */
export function rawProduct(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "6910",
    "product-name": "Charizard #4",
    "console-name": "Pokemon Base Set",
    "release-date": "1999-01-09",
    ...overrides,
  };
}
