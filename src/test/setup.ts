import "@testing-library/jest-dom";

// jsdom runs with an opaque origin, so its `localStorage`/`sessionStorage` are
// not usable. Install a spec-compliant in-memory Storage so browser-facing code
// behaves normally in tests. Unset keys still return null (no weakened checks).
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  const current = (globalThis as Record<string, unknown>)[name] as Storage | undefined;
  if (!current || typeof current.getItem !== "function") {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, name, { value: storage, writable: true, configurable: true });
    if (typeof window !== "undefined") {
      Object.defineProperty(window, name, { value: storage, writable: true, configurable: true });
    }
  }
}

if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });
}
