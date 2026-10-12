import { afterEach, describe, expect, it, vi } from "vitest";

// config.ts reads VITE_API / VITE_RPC / VITE_LOCAL at module load, so each case stubs env and
// re-imports fresh, as fiat.test.ts and chain.test.ts do.
afterEach(() => vi.unstubAllEnvs());

async function load() {
  vi.resetModules();
  return import("../config");
}

describe("APPRAISER_CONSOLE", () => {
  it("is enabled only by the literal string '1'", async () => {
    vi.stubEnv("VITE_APPRAISER_CONSOLE", "1");
    expect((await load()).APPRAISER_CONSOLE).toBe(true);

    vi.stubEnv("VITE_APPRAISER_CONSOLE", "true");
    expect((await load()).APPRAISER_CONSOLE).toBe(false);

    // Vite's test env is backed by process.env, which coerces every assigned value to a string.
    // Replace that object only for this import so the runtime number 1 stays a number.
    const originalEnv = process.env;
    Object.defineProperty(process, "env", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: { ...originalEnv, VITE_APPRAISER_CONSOLE: 1 } as unknown as typeof process.env,
    });
    try {
      expect((await load()).APPRAISER_CONSOLE).toBe(false);
    } finally {
      Object.defineProperty(process, "env", { configurable: true, enumerable: true, writable: true, value: originalEnv });
    }

    vi.stubEnv("VITE_APPRAISER_CONSOLE", "0");
    expect((await load()).APPRAISER_CONSOLE).toBe(false);
  });
});

describe("RPC / IS_LOCAL defaults", () => {
  it("routes through the backend's proxy when VITE_API is set and VITE_RPC is not, and is not local", async () => {
    // VITE_RPC and VITE_LOCAL are left unstubbed (undefined), not set to "": config.ts tells
    // "unset" from "" with `??`, which treats an empty string as an explicit value.
    vi.stubEnv("VITE_API", "http://localhost:8787");
    const { RPC, IS_LOCAL } = await load();
    expect(RPC).toBe("http://localhost:8787/api/rpc");
    expect(IS_LOCAL).toBe(false);
  });

  it("is local when VITE_LOCAL=1, even while proxied", async () => {
    vi.stubEnv("VITE_API", "http://localhost:8787");
    vi.stubEnv("VITE_LOCAL", "1");
    const { IS_LOCAL } = await load();
    expect(IS_LOCAL).toBe(true);
  });

  it("an explicit VITE_RPC wins over the proxy", async () => {
    vi.stubEnv("VITE_API", "http://localhost:8787");
    vi.stubEnv("VITE_RPC", "http://127.0.0.1:8899");
    const { RPC, IS_LOCAL } = await load();
    expect(RPC).toBe("http://127.0.0.1:8899");
    // Not proxied, and the URL names neither devnet, mainnet nor testnet: local by inference.
    expect(IS_LOCAL).toBe(true);
  });

  it("an explicit VITE_RPC naming a public cluster is not treated as local", async () => {
    vi.stubEnv("VITE_RPC", "https://api.devnet.solana.com");
    const { RPC, IS_LOCAL } = await load();
    expect(RPC).toBe("https://api.devnet.solana.com");
    expect(IS_LOCAL).toBe(false);
  });

  it("an explicitly empty VITE_RPC (a deploy that unsets it) still falls back to the proxy, not to ''", async () => {
    // config.ts uses `||`, not `??`, so "" is treated the same as unset. A deploy pipeline that
    // writes VITE_RPC= (empty) into the build env must not end up with RPC === "".
    vi.stubEnv("VITE_API", "http://localhost:8787");
    vi.stubEnv("VITE_RPC", "");
    const { RPC, IS_LOCAL } = await load();
    expect(RPC).toBe("http://localhost:8787/api/rpc");
    expect(IS_LOCAL).toBe(false);
  });

  it("an explicitly empty VITE_RPC with no backend falls back to the local default, not ''", async () => {
    vi.stubEnv("VITE_API", "");
    vi.stubEnv("VITE_RPC", "");
    const { RPC } = await load();
    expect(RPC).not.toBe("");
    expect(RPC).toMatch(/^http:\/\/.*:8899$/);
  });
});

describe("CLUSTER", () => {
  it("VITE_CLUSTER=devnet becomes the Wallet Standard identifier solana:devnet", async () => {
    vi.stubEnv("VITE_CLUSTER", "devnet");
    const { CLUSTER } = await load();
    expect(CLUSTER).toBe("solana:devnet");
  });

  it("an already-prefixed value passes through unchanged", async () => {
    vi.stubEnv("VITE_CLUSTER", "solana:devnet");
    const { CLUSTER } = await load();
    expect(CLUSTER).toBe("solana:devnet");
  });

  it("VITE_LOCAL=1 with a proxied VITE_API: solana:localnet", async () => {
    vi.stubEnv("VITE_API", "http://localhost:8787");
    vi.stubEnv("VITE_LOCAL", "1");
    const { CLUSTER } = await load();
    expect(CLUSTER).toBe("solana:localnet");
  });

  it("a proxied RPC with nothing else set: no cluster is named, never a guessed devnet", async () => {
    vi.stubEnv("VITE_API", "http://localhost:8787");
    expect((await load()).CLUSTER).toBeNull();
  });

  it("a keyed provider URL that names no cluster: none", async () => {
    vi.stubEnv("VITE_RPC", "https://rpc.helius.xyz/?api-key=abc");
    expect((await load()).CLUSTER).toBeNull();
  });

  it("the default Surfpool endpoint (no backend, no VITE_RPC) is localnet", async () => {
    expect((await load()).CLUSTER).toBe("solana:localnet");
  });

  it("an unproxied loopback RPC is localnet", async () => {
    vi.stubEnv("VITE_RPC", "http://127.0.0.1:8899");
    expect((await load()).CLUSTER).toBe("solana:localnet");
  });

  it("an unproxied VITE_RPC that names its cluster is believed", async () => {
    vi.stubEnv("VITE_RPC", "https://api.devnet.solana.com");
    expect((await load()).CLUSTER).toBe("solana:devnet");

    vi.stubEnv("VITE_RPC", "https://api.testnet.solana.com");
    expect((await load()).CLUSTER).toBe("solana:testnet");

    vi.stubEnv("VITE_RPC", "https://api.mainnet-beta.solana.com");
    expect((await load()).CLUSTER).toBe("solana:mainnet");
  });

  it("VITE_CLUSTER wins over a proxied backend", async () => {
    vi.stubEnv("VITE_API", "https://relstate.fly.dev");
    vi.stubEnv("VITE_CLUSTER", "devnet");
    expect((await load()).CLUSTER).toBe("solana:devnet");
  });
});

describe("DEFAULT_PUBLIC_HOLDBACK", () => {
  it("defaults to 100,000,000 base units (100 rUSDC) with no override", async () => {
    const { DEFAULT_PUBLIC_HOLDBACK } = await load();
    expect(DEFAULT_PUBLIC_HOLDBACK).toBe(100_000_000);
  });

  it("VITE_DEFAULT_PUBLIC_HOLDBACK='0' overrides it to 0, not the default", async () => {
    vi.stubEnv("VITE_DEFAULT_PUBLIC_HOLDBACK", "0");
    const { DEFAULT_PUBLIC_HOLDBACK } = await load();
    expect(DEFAULT_PUBLIC_HOLDBACK).toBe(0);
  });

  it("an explicit override is honoured", async () => {
    vi.stubEnv("VITE_DEFAULT_PUBLIC_HOLDBACK", "25000000");
    const { DEFAULT_PUBLIC_HOLDBACK } = await load();
    expect(DEFAULT_PUBLIC_HOLDBACK).toBe(25_000_000);
  });
});
