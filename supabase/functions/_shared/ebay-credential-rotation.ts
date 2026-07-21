// Durable persistence of a rotated eBay refresh token — pure and cross-runtime.
//
// eBay MAY return a new refresh_token when we exchange the old one. If it does
// and we fail to store it, the credential in the database is stale (eBay may
// have invalidated the old token), so every later refresh will fail silently.
// This helper makes that outcome explicit and unit-testable: the encryption and
// the database write are BOTH injected, and the write is conditioned on the
// ciphertext we started from (optimistic concurrency) so a concurrent refresh
// that already rotated the credential is never regressed to an older token.
//
// Supabase mutations RESOLVE with an `{ error }` property on failure rather than
// throwing, so the injected `update` returns `{ error, rowCount }` and the caller
// classifies the result. No token value is ever returned or logged.

export type RotationOutcome =
  | "unchanged" // eBay returned no new refresh token; nothing to persist
  | "rotated" // the replacement was written (1 row)
  | "superseded" // a concurrent refresh already rotated it; theirs is kept
  | "persist_failed"; // the write resolved with an error; stored token is stale

export interface RotationUpdateResult {
  error: unknown;
  rowCount: number;
}

export interface RotationResult {
  outcome: RotationOutcome;
  /** Present only on `persist_failed`; the raw DB error, never a token value. */
  error?: unknown;
}

export async function persistRotatedRefreshToken(args: {
  accountId: string;
  /** Ciphertext read at the start of the refresh — the concurrency guard. */
  priorEncrypted: string;
  newRefreshToken: string | null | undefined;
  refreshTokenExpiresInSec?: number | null;
  scopes?: string[] | null;
  encrypt: (token: string) => Promise<string>;
  update: (
    patch: Record<string, unknown>,
    where: { accountId: string; priorEncrypted: string },
  ) => Promise<RotationUpdateResult>;
  now?: () => number;
}): Promise<RotationResult> {
  if (!args.newRefreshToken) return { outcome: "unchanged" };
  const clock = args.now ?? (() => Date.now());

  const patch: Record<string, unknown> = {
    refresh_token_encrypted: await args.encrypt(args.newRefreshToken),
    rotated_at: new Date(clock()).toISOString(),
  };
  if (args.refreshTokenExpiresInSec) {
    patch.refresh_token_expires_at = new Date(clock() + args.refreshTokenExpiresInSec * 1000).toISOString();
  }
  if (args.scopes && args.scopes.length) patch.scopes = args.scopes;

  // The write targets ONLY this account and ONLY while the stored ciphertext is
  // still the one we refreshed from — so unrelated accounts are untouched and a
  // newer concurrent rotation cannot be overwritten with an older token.
  const { error, rowCount } = await args.update(patch, {
    accountId: args.accountId,
    priorEncrypted: args.priorEncrypted,
  });
  if (error) return { outcome: "persist_failed", error };
  if (rowCount === 0) return { outcome: "superseded" };
  return { outcome: "rotated" };
}
