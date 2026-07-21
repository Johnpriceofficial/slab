import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EbaySellerPanel } from "@/components/slabs/EbaySellerPanel";
import type { Slab } from "@/lib/slabs/types";

vi.mock("@/lib/slabs/data", () => ({
  fetchEbayAccounts: vi.fn(async () => []),
  ebaySellerOperation: vi.fn(),
  startEbayOAuth: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const slab = {
  id: "s1", inventory_number: 46, card_name: "Test", grader: "PSA", grade: "9",
  set_name: "Set", card_number: "1", grade_label: "MINT", final_value_cents: 1000,
} as unknown as Slab;

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EbaySellerPanel slab={slab} />
    </QueryClientProvider>,
  );
}

describe("EbaySellerPanel OAuth callback banner", () => {
  beforeEach(() => { window.history.replaceState({}, "", "/slabs/s1"); });

  it("surfaces identity_scope_missing as a persistent inline banner and strips the URL marker", async () => {
    window.history.replaceState({}, "", "/slabs/s1?ebay=identity_scope_missing");
    renderPanel();
    expect(await screen.findByText(/required Identity permission/i)).toBeTruthy();
    expect(window.location.search).toBe(""); // marker removed without reload
  });

  it("shows a connected banner that can be dismissed", async () => {
    window.history.replaceState({}, "", "/slabs/s1?ebay=connected");
    renderPanel();
    expect(await screen.findByText(/account connected/i)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Dismiss eBay status"));
    expect(screen.queryByText(/account connected/i)).toBeNull();
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
