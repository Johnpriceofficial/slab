/**
 * Regression: a background session re-verification for the SAME user
 * (Supabase fires onAuthStateChange on token refresh, and often on tab
 * focus) must never flash the "loading" status over an already-resolved
 * page. Only a genuinely new session (sign-in, or a different user) should
 * show loading while it resolves. This is the "the screen appears then
 * disappears" symptom reported live: any protected route unmounts its real
 * content and shows the checking-account spinner on every background
 * refresh, then remounts once the admin-check RPC resolves.
 */
import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth, type AuthClient } from "@/auth/AuthProvider";

type Session = { user: { id: string; email?: string | null; email_confirmed_at?: string | null } } | null;

function makeClient(opts: { initialSession: Session; adminIds?: string[]; rpcDelayMs?: number }) {
  let handler: ((event: string, session: Session) => void) | null = null;
  const admins = new Set(opts.adminIds ?? []);
  let rpcCalls = 0;
  const client: AuthClient = {
    auth: {
      getSession: async () => ({ data: { session: opts.initialSession } }),
      onAuthStateChange: (cb) => {
        handler = cb;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      signInWithPassword: async () => ({ error: null }),
      signUp: async () => ({ data: { session: null }, error: null }),
      resetPasswordForEmail: async () => ({ error: null }),
      updateUser: async () => ({ error: null }),
      signOut: async () => ({ error: null }),
    },
    rpc: async (_fn, args) => {
      rpcCalls += 1;
      if (opts.rpcDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.rpcDelayMs));
      return { data: admins.has(String(args._user_id)), error: null };
    },
  };
  return { client, emit: (s: Session) => handler?.("TOKEN_REFRESHED", s), rpcCalls: () => rpcCalls };
}

function StatusHistoryProbe({ history }: { history: string[] }) {
  const { status } = useAuth();
  history.push(status);
  return <span data-testid="status">{status}</span>;
}

const userSession: Session = { user: { id: "user-2", email: "user@slabvault.test" } };

describe("AuthProvider — background refresh must not flash loading", () => {
  it("re-verifying the SAME already-resolved user never passes through 'loading' again", async () => {
    const { client, emit, rpcCalls } = makeClient({ initialSession: userSession, adminIds: [], rpcDelayMs: 10 });
    const history: string[] = [];
    render(
      <AuthProvider client={client}>
        <StatusHistoryProbe history={history} />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("customer"));
    expect(rpcCalls()).toBe(1);

    history.length = 0; // only inspect statuses observed AFTER the background refresh below
    emit(userSession); // simulates Supabase's TOKEN_REFRESHED for the same session
    await waitFor(() => expect(rpcCalls()).toBe(2));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("customer"));

    // The whole point: "loading" must never appear in the history during this
    // background re-verification — the real bug was every history entry
    // flipping through "loading" before settling back to "customer".
    expect(history).not.toContain("loading");
  });

  it("still shows loading for a genuinely new sign-in (different user id)", async () => {
    const { client, emit } = makeClient({ initialSession: userSession, adminIds: [], rpcDelayMs: 10 });
    const history: string[] = [];
    render(
      <AuthProvider client={client}>
        <StatusHistoryProbe history={history} />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("customer"));

    history.length = 0;
    const differentUserSession: Session = { user: { id: "user-99", email: "other@slabvault.test" } };
    emit(differentUserSession);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("customer"));

    // A different user id IS a new session to resolve — loading is expected here.
    expect(history).toContain("loading");
  });

  it("promotion on background refresh still lands on admin (no functional regression)", async () => {
    const { client, emit } = makeClient({ initialSession: userSession, adminIds: ["user-2"] });
    render(
      <AuthProvider client={client}>
        <StatusHistoryProbe history={[]} />
      </AuthProvider>,
    );
    // First resolution sees adminIds already containing user-2 → admin directly.
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("admin"));
    emit(userSession);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("admin"));
  });
});
