import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { BuilderRunRow } from "@/lib/builder/data";

// Mock the read-only data layer so the page test needs no Supabase/network.
const fetchBuilderRuns = vi.fn<() => Promise<BuilderRunRow[]>>();
vi.mock("@/lib/builder/data", () => ({ fetchBuilderRuns: () => fetchBuilderRuns() }));

import Builder from "@/pages/builder/Builder";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><Builder /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Builder page (Phase 1 read-only)", () => {
  beforeEach(() => fetchBuilderRuns.mockReset());

  it("always shows the permission model and the disabled-connectors safety notice", async () => {
    fetchBuilderRuns.mockResolvedValue([]);
    renderPage();
    // The four-level permission contract is visible.
    expect(screen.getByText("Production write")).toBeTruthy();
    expect(screen.getByText("Destructive / external")).toBeTruthy();
    expect(screen.getByText("Typed confirmation")).toBeTruthy();
    // The honest Phase-1 limitation is surfaced.
    expect(screen.getByText(/disabled/i)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/No builder runs yet/i)).toBeTruthy());
  });

  it("renders run rows when the read returns runs", async () => {
    fetchBuilderRuns.mockResolvedValue([{
      id: "r1", project: "slab", environment: "preview", instruction: "Fix the eBay authorization flow",
      status: "waiting_for_approval", session_mode: "read_only", correlation_id: "c1",
      created_at: "2026-07-24T00:00:00Z", updated_at: "2026-07-24T00:00:00Z",
    }]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Fix the eBay authorization flow")).toBeTruthy());
    expect(screen.getByText("waiting_for_approval")).toBeTruthy();
  });
});
