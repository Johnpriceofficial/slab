import { describe, it, expect, vi } from "vitest";
import { persistRotatedRefreshToken } from "../../../supabase/functions/_shared/ebay-credential-rotation";

// A deterministic fake encryptor so tests can assert the PLAINTEXT token never
// leaks into the persisted patch or any returned value.
const PLAINTEXT = "v^1.1#i^1#SECRET-REFRESH-TOKEN-should-never-appear";
const encrypt = async (t: string) => `enc(${t.length})`; // opaque; not the plaintext

type UpdateFn = (
  patch: Record<string, unknown>,
  where: { accountId: string; priorEncrypted: string },
) => Promise<{ error: unknown; rowCount: number }>;

describe("persistRotatedRefreshToken (P1 finding A2)", () => {
  it("does nothing and reports 'unchanged' when eBay returns no new refresh token", async () => {
    const update = vi.fn<UpdateFn>();
    const res = await persistRotatedRefreshToken({
      accountId: "acct-1", priorEncrypted: "old-cipher", newRefreshToken: null,
      encrypt, update,
    });
    expect(res.outcome).toBe("unchanged");
    expect(update).not.toHaveBeenCalled();
  });

  it("persists the encrypted replacement and reports 'rotated' (1 row); never writes plaintext", async () => {
    const update = vi.fn<UpdateFn>(async () => ({ error: null, rowCount: 1 }));
    const res = await persistRotatedRefreshToken({
      accountId: "acct-1", priorEncrypted: "old-cipher", newRefreshToken: PLAINTEXT,
      refreshTokenExpiresInSec: 3600, scopes: ["sell.inventory"],
      encrypt, update, now: () => 1_700_000_000_000,
    });
    expect(res.outcome).toBe("rotated");
    const [patch, where] = update.mock.calls[0];
    // Encrypted, never plaintext.
    expect(patch.refresh_token_encrypted).toBe(`enc(${PLAINTEXT.length})`);
    expect(JSON.stringify(patch)).not.toContain(PLAINTEXT);
    expect(patch.rotated_at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(patch.refresh_token_expires_at).toBe(new Date(1_700_000_000_000 + 3600_000).toISOString());
    expect(patch.scopes).toEqual(["sell.inventory"]);
    // Optimistic concurrency + account scoping: write is conditioned on the
    // ciphertext we refreshed from and targets ONLY this account.
    expect(where).toEqual({ accountId: "acct-1", priorEncrypted: "old-cipher" });
  });

  it("reports 'superseded' (no regression) when a concurrent rotation already won (0 rows)", async () => {
    const update = vi.fn<UpdateFn>(async () => ({ error: null, rowCount: 0 }));
    const res = await persistRotatedRefreshToken({
      accountId: "acct-1", priorEncrypted: "old-cipher", newRefreshToken: PLAINTEXT, encrypt, update,
    });
    expect(res.outcome).toBe("superseded");
  });

  it("surfaces 'persist_failed' when the write resolves with { error }; no token in output", async () => {
    const dbError = { code: "40001", message: "could not serialize access" };
    const update = vi.fn<UpdateFn>(async () => ({ error: dbError, rowCount: 0 }));
    const res = await persistRotatedRefreshToken({
      accountId: "acct-1", priorEncrypted: "old-cipher", newRefreshToken: PLAINTEXT, encrypt, update,
    });
    expect(res.outcome).toBe("persist_failed");
    expect(res.error).toBe(dbError);
    expect(JSON.stringify(res)).not.toContain(PLAINTEXT);
  });
});
