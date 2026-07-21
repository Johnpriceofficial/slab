import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PanelErrorBoundary } from "@/components/shared/PanelErrorBoundary";

function Bomb(): never {
  throw new Error("panel exploded");
}

function Safe() {
  return <div>Sibling panel content</div>;
}

describe("PanelErrorBoundary", () => {
  const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  afterEach(() => {
    cleanup();
    consoleErrorSpy.mockClear();
  });

  it("renders children normally when nothing throws", () => {
    render(
      <PanelErrorBoundary panelName="Test Panel">
        <Safe />
      </PanelErrorBoundary>,
    );
    expect(screen.getByText("Sibling panel content")).toBeInTheDocument();
  });

  it("shows an inline, named fallback instead of blanking when the panel throws", () => {
    render(
      <PanelErrorBoundary panelName="PriceCharting Marketplace">
        <Bomb />
      </PanelErrorBoundary>,
    );
    expect(screen.getByText("PriceCharting Marketplace failed to load")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("containment: a failing panel does not take down a sibling panel outside its own boundary", () => {
    render(
      <div>
        <PanelErrorBoundary panelName="PriceCharting Marketplace">
          <Bomb />
        </PanelErrorBoundary>
        <PanelErrorBoundary panelName="eBay Listing, Orders & Fulfillment">
          <Safe />
        </PanelErrorBoundary>
      </div>,
    );
    expect(screen.getByText("PriceCharting Marketplace failed to load")).toBeInTheDocument();
    expect(screen.getByText("Sibling panel content")).toBeInTheDocument();
  });

  it("in-place retry re-renders the subtree and recovers a transient failure without a page reload", () => {
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error("transient");
      return <div>recovered</div>;
    }
    render(
      <PanelErrorBoundary panelName="Market Intelligence">
        <Flaky />
      </PanelErrorBoundary>,
    );
    expect(screen.getByText("Market Intelligence failed to load")).toBeInTheDocument();
    shouldThrow = false; // the underlying condition clears
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(screen.getByText("recovered")).toBeInTheDocument();
  });

  it("retry falls back again (no worse than before) if the failure is deterministic, not transient", () => {
    render(
      <PanelErrorBoundary panelName="eBay Listing, Orders & Fulfillment">
        <Bomb />
      </PanelErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(screen.getByText("eBay Listing, Orders & Fulfillment failed to load")).toBeInTheDocument();
  });
});
