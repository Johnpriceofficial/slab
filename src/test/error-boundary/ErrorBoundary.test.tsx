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
});
