/**
 * Detects the "stale deploy" class of error: a browser tab open across a
 * production deploy tries to lazy-load a route chunk (via React.lazy /
 * dynamic import()) whose content-hashed file no longer exists because a
 * newer deploy replaced it. Different bundlers/browsers phrase the resulting
 * rejection differently, so this matches on the known message shapes rather
 * than a single string.
 */

const CHUNK_LOAD_ERROR_PATTERNS: RegExp[] = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /loading chunk .* failed/i,
  /loading css chunk .* failed/i,
];

/** True if `error` looks like a failed dynamic import of a stale/missing route chunk. */
export function isChunkLoadError(error: unknown): boolean {
  if (error == null) return false;
  const message = error instanceof Error ? error.message : String(error);
  return CHUNK_LOAD_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
