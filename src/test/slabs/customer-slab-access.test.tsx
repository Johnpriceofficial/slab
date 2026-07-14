/**
 * Customer-facing slab access: the UI half of the ownership change.
 *
 * RLS is the real boundary (proved in slab-ownership.integration.test.ts). These
 * tests cover what the browser must do on top of it: a verified customer reaches
 * the slab screens instead of "Access denied", and the administrative tools
 * (exports, bulk/marketplace, permanent delete) never render for them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProtectedUserRoute } from "@/components/auth/ProtectedUserRoute";
import { ProtectedAdminRoute } from "@/components/auth/ProtectedAdminRoute";
import { SlabAdminActions } from "@/components/slabs/SlabAdminActions";
import type { AuthStatus } from "@/auth/AuthProvider";
import type { Slab } from "@/lib/slabs/types";

const { authState } = vi.hoisted(() => ({ authState: { status: "customer" as AuthStatus } }));

vi.mock("@/auth/AuthProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/auth/AuthProvider")>()),
  useAuth: () => ({ status: authState.status, user: { id: "u1", email: "c@example.com" }, signOut: vi.fn() }),
}));

vi.mock("@/lib/slabs/data", () => ({
  archiveSlab: vi.fn(),
  unarchiveSlab: vi.fn(),
  hardDeleteSlab: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

const slab = { id: "s1", inventory_number: 7, archived_at: null } as unknown as Slab;

function renderWithProviders(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  authState.status = "customer";
});

describe("verified customers can reach the slab screens", () => {
  it("renders slab routes for a verified customer instead of Access denied", () => {
    authState.status = "customer";
    renderWithProviders(<ProtectedUserRoute><div>Add a Slab</div></ProtectedUserRoute>);

    expect(screen.getByText("Add a Slab")).toBeInTheDocument();
    // The dead end the scanner used to lead to is gone.
    expect(screen.queryByText(/access denied/i)).not.toBeInTheDocument();
  });

  it("still shows Access denied on admin-only routes", () => {
    authState.status = "customer";
    renderWithProviders(<ProtectedAdminRoute><div>Dashboard</div></ProtectedAdminRoute>);

    expect(screen.getByText(/access denied/i)).toBeInTheDocument();
    expect(screen.queryByText("Dashboard")).not.toBeInTheDocument();
  });

  it("blocks an unverified account from the slab screens", () => {
    authState.status = "unverified";
    renderWithProviders(<ProtectedUserRoute><div>Add a Slab</div></ProtectedUserRoute>);

    expect(screen.getByText(/verify your email/i)).toBeInTheDocument();
    expect(screen.queryByText("Add a Slab")).not.toBeInTheDocument();
  });
});

describe("administrative slab tools stay admin-only", () => {
  it("lets a customer archive their own slab but never permanently delete it", () => {
    authState.status = "customer";
    renderWithProviders(<SlabAdminActions slab={slab} />);

    expect(screen.getByRole("button", { name: /archive/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete test record/i })).not.toBeInTheDocument();
  });

  it("offers the permanent delete to an admin", () => {
    authState.status = "admin";
    renderWithProviders(<SlabAdminActions slab={slab} />);

    expect(screen.getByRole("button", { name: /delete test record/i })).toBeInTheDocument();
  });
});
