/**
 * P1.4: a panel throwing must not take down the rest of the page. Verifies
 * containment specifically -- a failing panel shows an inline fallback
 * while a sibling panel (outside the same boundary) keeps rendering.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
});
