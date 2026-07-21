import { describe, it, expect } from "vitest";
import { isChunkLoadError } from "@/lib/error-boundary/chunk-error";

describe("isChunkLoadError", () => {
  it("matches the Vite/browser dynamic-import failure message", () => {
    expect(isChunkLoadError(new Error("Failed to fetch dynamically imported module: https://x/y.js"))).toBe(true);
  });

  it("matches Safari's module-script-load phrasing", () => {
    expect(isChunkLoadError(new Error("Importing a module script failed"))).toBe(true);
  });

  it("matches webpack's Loading chunk N failed phrasing", () => {
    expect(isChunkLoadError(new Error("Loading chunk 42 failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Loading CSS chunk 7 failed."))).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isChunkLoadError(new Error("FAILED TO FETCH DYNAMICALLY IMPORTED MODULE"))).toBe(true);
  });

  it("returns false for an ordinary application error", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of null (reading 'foo')"))).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });

  it("handles non-Error thrown values via String()", () => {
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(true);
    expect(isChunkLoadError({ some: "object" })).toBe(false);
  });
});
