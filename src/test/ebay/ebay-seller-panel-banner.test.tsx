import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EbaySellerPanel } from "@/components/slabs/EbaySellerPanel";
import type { Slab } from "@/lib/slabs/types";

const { accountsMock, startMock } = vi.hoisted(() => ({
  accountsMock: vi.fn(async () => [] as Array<Record<string, unknown>>),
  startMock: vi.fn(async () => ({ status: "error", message: "test stop" })),
}));
vi.mock("@/lib/slabs/ebay-data", () => ({
  fetchEbayAccounts: accountsMock,
  fetchEbaySyncCursors: vi.fn(async () => []),
  fetchEbayLocations: vi.fn(async () => []),
  fetchEbayBusinessPolicies: vi.fn(async () => []),
  ebaySellerOperation: vi.fn(),
  startEbayOAuth: startMock,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const slab = {
  id: "s1", inventory_number: 46, card_name: "Test", grader: "PSA", grade: "9",
  set_name: "Set", card_number: "1", grade_label: "MINT", final_value_cents: 1000,
} as unknown as Slab;

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><EbaySellerPanel slab={slab} /></QueryClientProvider>);
}

describe("EbaySellerPanel OAuth status", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/slabs/s1");
    accountsMock.mockReset();
    accountsMock.mockResolvedValue([]);
    startMock.mockReset();
    startMock.mockResolvedValue({ status: "error", message: "test stop" });
  });

  it("surfaces identity_scope_missing as a persistent inline banner and strips the URL marker", async () => {
    window.history.replaceState({}, "", "/slabs/s1?ebay=identity_scope_missing");
    renderPanel();
    expect(await screen.findByText(/required Identity permission/i)).toBeTruthy();
    expect(window.location.search).toBe("");
  });

  it("shows a connected banner that can be dismissed", async () => {
    window.history.replaceState({}, "", "/slabs/s1?ebay=connected");
    renderPanel();
    expect(await screen.findByText(/account connected/i)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Dismiss eBay status"));
    expect(screen.queryByText(/account connected/i)).toBeNull();
  });

  it("keeps a rejected account visible and shows an explicit Reconnect eBay action", async () => {
    accountsMock.mockResolvedValue([{ id: "a1", display_label: "Connected eBay seller", connection_status: "reauthorization_required", privilege_status: "verified", connected_at: "2026-07-21T20:58:00Z" }]);
    renderPanel();
    const buttons = await screen.findAllByRole("button", { name: "Reconnect eBay" });
    expect(buttons.length).toBeGreaterThan(0);
    expect(screen.getByText(/saved authorization was rejected/i)).toBeTruthy();
    const publishButton = screen.getByRole("button", { name: "Publish with confirmation" }) as HTMLButtonElement;
    await waitFor(() => expect(publishButton.disabled).toBe(true));
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
  });

  it("shows distinct banners for other stages and no banner without a marker", async () => {
    window.history.replaceState({}, "", "/slabs/s1?ebay=persist_error");
    const { unmount } = renderPanel();
    expect(await screen.findByText(/could not be saved/i)).toBeTruthy();
    unmount();
    window.history.replaceState({}, "", "/slabs/s1");
    renderPanel();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
