import { vi } from "vitest";

/** An in-memory localStorage: the node environment has none, and the modules under test degrade without it. */
export function stubLocalStorage() {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  });
  return m;
}
