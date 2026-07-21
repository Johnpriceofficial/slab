/**
 * Extends P1.4 containment to the three remaining unguarded slab-detail
 * panels found while investigating the recurring "Something went wrong"
 * crash on /slabs/3455aa7b-a727-4814-91eb-9a3dd6f17846: Sales Comps, Market
 * Intelligence, and Verification & Field Evidence. Before this, a throw in
 * ANY of these — same as the two admin-only panels fixed in #38 — blanked
 * the whole page instead of degrading just that section.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PanelErrorBoundary } from "@/components/shared/PanelErrorBoundary";

function Bomb(): never {
  throw new Error("section exploded");
}
function Safe() {
  return <div>Unrelated section content</div>;
}

afterEach(cleanup);

describe("PanelErrorBoundary coverage for read-only slab-detail sections", () => {
  it.each(["Sales Comps", "Market Intelligence", "Verification & Field Evidence"])(
    "contains a throw in the %s section without taking down a sibling section",
    (panelName) => {
      render(
        <div>
          <PanelErrorBoundary panelName={panelName}>
            <Bomb />
          </PanelErrorBoundary>
          <PanelErrorBoundary panelName="Sibling">
            <Safe />
          </PanelErrorBoundary>
        </div>,
      );
      expect(screen.getByText(`${panelName} failed to load`)).toBeInTheDocument();
      expect(screen.getByText("Unrelated section content")).toBeInTheDocument();
    },
  );
});
