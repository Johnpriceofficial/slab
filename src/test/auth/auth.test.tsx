/**
 * Frontend auth + admin-guard tests. A controllable fake AuthClient drives every
 * state the guard must handle: no session, failed verification, authenticated
 * non-admin, authenticated admin, session refresh, sign-out, and direct
 * navigation to a protected route.
 */

import { describe, it, expect } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth, type AuthClient } from "@/auth/AuthProvider";
import { ProtectedAdminRoute } from "@/components/auth/ProtectedAdminRoute";
import { ProtectedUserRoute } from "@/components/auth/ProtectedUserRoute";

type Session = { user: { id: string; email?: string | null; email_confirmed_at?: string | null } } | null;

interface FakeOpts {
  initialSession?: Session;
  adminIds?: string[];
  signInError?: string | null;
  rpcErrors?: boolean;
}

function makeClient(opts: FakeOpts = {}) {
  let handler: ((event: string, session: Session) => void) | null = null;
  const admins = new Set(opts.adminIds ?? []);
  const client: AuthClient = {
    auth: {
      getSession: async () => ({ data: { session: opts.initialSession ?? null } }),
      onAuthStateChange: (cb) => {
        handler = cb;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      signInWithPassword: async () => ({ error: opts.signInError ? { message: opts.signInError } : null }),
      signUp: async () => ({ data: { session: null }, error: null }),
      resetPasswordForEmail: async () => ({ error: null }),
      updateUser: async () => ({ error: null }),
      signOut: async () => ({ error: null }),
    },
    rpc: async (_fn, args) => {
      if (opts.rpcErrors) return { data: null, error: { message: "rpc failed" } };
      return { data: admins.has(String(args._user_id)), error: null };
    },
  };
  return { client, admins, emit: (s: Session) => handler?.("CHANGE", s) };
}

function StatusProbe() {
  const { status, user, signOut } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="email">{user?.email ?? "none"}</span>
      <button onClick={() => void signOut()}>do-signout</button>
    </div>
  );
}

function renderProbe(client: AuthClient) {
  return render(
    <AuthProvider client={client}>
      <StatusProbe />
    </AuthProvider>,
  );
}

function renderRoutes(client: AuthClient, entry = "/dashboard") {
  return render(
    <AuthProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/login" element={<div>LOGIN PAGE</div>} />
          <Route path="/scan-card" element={<ProtectedUserRoute><div>CUSTOMER SCANNER</div></ProtectedUserRoute>} />
          <Route
            path="/dashboard"
            element={
              <ProtectedAdminRoute>
                <div>SECRET DASHBOARD</div>
              </ProtectedAdminRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

const adminSession: Session = { user: { id: "admin-1", email: "admin@slabvault.test" } };
const userSession: Session = { user: { id: "user-2", email: "user@slabvault.test" } };

describe("AuthProvider status machine", () => {
  it("no session → signed_out", async () => {
    const { client } = makeClient({ initialSession: null });
    renderProbe(client);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signed_out"));
  });

  it("authenticated admin → admin", async () => {
    const { client } = makeClient({ initialSession: adminSession, adminIds: ["admin-1"] });
    renderProbe(client);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("admin"));
    expect(screen.getByTestId("email")).toHaveTextContent("admin@slabvault.test");
  });

  it("authenticated non-admin → customer", async () => {
    const { client } = makeClient({ initialSession: userSession, adminIds: [] });
    renderProbe(client);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("customer"));
  });

  it("failed/invalid admin verification remains a customer, never an admin", async () => {
    const { client } = makeClient({ initialSession: adminSession, adminIds: ["admin-1"], rpcErrors: true });
    renderProbe(client);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("customer"));
  });

  it("unconfirmed email → unverified", async () => {
    const unverified: Session = { user: { id: "user-3", email: "new@example.test", email_confirmed_at: null } };
    const { client } = makeClient({ initialSession: unverified });
    renderProbe(client);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("unverified"));
  });

  it("session refresh re-verifies admin and can promote", async () => {
    const { client, admins, emit } = makeClient({ initialSession: userSession, adminIds: [] });
    renderProbe(client);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("customer"));
    // Account is granted admin, then a refreshed session arrives.
    admins.add("user-2");
    emit(userSession);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("admin"));
  });

  it("session cleared by an auth event → signed_out", async () => {
    const { client, emit } = makeClient({ initialSession: adminSession, adminIds: ["admin-1"] });
    renderProbe(client);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("admin"));
    emit(null);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signed_out"));
  });

  it("explicit sign-out → signed_out", async () => {
    const { client } = makeClient({ initialSession: adminSession, adminIds: ["admin-1"] });
    renderProbe(client);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("admin"));
    fireEvent.click(screen.getByText("do-signout"));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signed_out"));
  });
});

describe("ProtectedAdminRoute", () => {
  it("admin sees protected content", async () => {
    const { client } = makeClient({ initialSession: adminSession, adminIds: ["admin-1"] });
    renderRoutes(client);
    expect(await screen.findByText("SECRET DASHBOARD")).toBeInTheDocument();
  });

  it("direct navigation while signed out redirects to /login", async () => {
    const { client } = makeClient({ initialSession: null });
    renderRoutes(client, "/dashboard");
    expect(await screen.findByText("LOGIN PAGE")).toBeInTheDocument();
    expect(screen.queryByText("SECRET DASHBOARD")).not.toBeInTheDocument();
  });

  it("authenticated non-admin sees an explicit Access denied page (not the content)", async () => {
    const { client } = makeClient({ initialSession: userSession, adminIds: [] });
    renderRoutes(client);
    expect(await screen.findByText("Access denied")).toBeInTheDocument();
    expect(screen.queryByText("SECRET DASHBOARD")).not.toBeInTheDocument();
  });

  it("authenticated customer can open the scanner route", async () => {
    const { client } = makeClient({ initialSession: userSession, adminIds: [] });
    renderRoutes(client, "/scan-card");
    expect(await screen.findByText("CUSTOMER SCANNER")).toBeInTheDocument();
  });
});
