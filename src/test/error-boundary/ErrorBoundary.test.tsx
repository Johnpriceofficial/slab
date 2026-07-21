import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ErrorBoundary, CHUNK_RELOAD_GUARD_KEY } from "@/components/shared/ErrorBoundary";

function Bomb({ message }: { message: string }): never {
  throw new Error(message);
}

function Safe() {
  return <div>All good</div>;
}

describe("ErrorBoundary", () => {
  let reloadSpy: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sessionStorage.clear();
    reloadSpy = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    });
    // React logs caught errors to console.error too — silence that expected noise.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleErrorSpy.mockRestore();
  });

  it("renders children normally when nothing throws", () => {
    render(
      <ErrorBoundary>
        <Safe />
      </ErrorBoundary>,
    );
    expect(screen.getByText("All good")).toBeInTheDocument();
  });

  it("shows an actionable fallback (not blank) for an ordinary render error", () => {
    render(
      <ErrorBoundary>
        <Bomb message="Cannot read properties of null (reading 'foo')" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload page/i })).toBeInTheDocument();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("auto-reloads once for a chunk-load failure instead of showing the fallback", () => {
    render(
      <ErrorBoundary>
        <Bomb message="Failed to fetch dynamically imported module: /assets/SlabDetail-abc123.js" />
      </ErrorBoundary>,
    );
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY)).toBe("1");
    // No error text flashed to the user while the reload is in flight.
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  it("falls through to the fallback (does not loop) if a chunk error recurs after the guard is already set", () => {
    sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, "1");
    render(
      <ErrorBoundary>
        <Bomb message="Failed to fetch dynamically imported module: /assets/SlabDetail-abc123.js" />
      </ErrorBoundary>,
    );
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("clears the reload guard and reloads when the user clicks Reload page", () => {
    sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, "1");
    render(
      <ErrorBoundary>
        <Bomb message="Cannot read properties of null (reading 'foo')" />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: /reload page/i }));
    expect(sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY)).toBeNull();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  describe("panel variant (narrower boundary)", () => {
    it("renders a COMPACT labeled fallback with in-place retry, not the full-page reload UI", () => {
      render(
        <ErrorBoundary variant="panel" label="eBay listing">
          <Bomb message="panel blew up" />
        </ErrorBoundary>,
      );
      expect(screen.getByText(/eBay listing.*couldn.t load/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
      // NOT the full-page fallback and no page reload.
      expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /reload page/i })).not.toBeInTheDocument();
      expect(reloadSpy).not.toHaveBeenCalled();
    });

    it("isolates a failing panel so a sibling panel stays rendered", () => {
      render(
        <div>
          <ErrorBoundary variant="panel" label="Marketplace listing">
            <Bomb message="one panel down" />
          </ErrorBoundary>
          <ErrorBoundary variant="panel" label="eBay listing">
            <Safe />
          </ErrorBoundary>
        </div>,
      );
      // The failing panel shows its fallback; the sibling still renders.
      expect(screen.getByText(/Marketplace listing.*couldn.t load/i)).toBeInTheDocument();
      expect(screen.getByText("All good")).toBeInTheDocument();
    });

    it("in-place retry re-renders the subtree and recovers a transient failure", () => {
      let shouldThrow = true;
      function Flaky() {
        if (shouldThrow) throw new Error("transient");
        return <div>recovered</div>;
      }
      render(
        <ErrorBoundary variant="panel" label="Marketplace listing">
          <Flaky />
        </ErrorBoundary>,
      );
      expect(screen.getByText(/Marketplace listing.*couldn.t load/i)).toBeInTheDocument();
      shouldThrow = false; // the underlying condition clears
      fireEvent.click(screen.getByRole("button", { name: /try again/i }));
      expect(screen.getByText("recovered")).toBeInTheDocument();
    });
  });
});
