import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrivySdk } from "../privy";

// mode.ts reads env at load and registerPrivySdk is module state, so each case re-imports and
// registers on that same instance.
async function load(env: { mode?: string; appId?: string } = {}) {
  vi.resetModules();
  vi.stubEnv("VITE_EMBEDDED_WALLET", env.mode ?? "");
  vi.stubEnv("VITE_EMBEDDED_WALLET_APP_ID", env.appId ?? "");
  return import("../backends");
}
afterEach(() => vi.unstubAllEnvs());

const fakeSdk = (): PrivySdk => ({
  sendCode: async () => {},
  loginWithCode: async () => {},
  solanaWallet: async () => null,
  logout: async () => {},
});

describe("activeBackend", () => {
  it("mock mode gives the mock backend and no reason", async () => {
    const b = await load({ mode: "mock" });
    const a = b.activeBackend();
    expect(a.backend?.id).toBe("mock");
    expect(a.reason).toBeNull();
  });

  it("an app id with no SDK registered is unavailable and points at privy.ts", async () => {
    const a = (await load({ appId: "app-1" })).activeBackend();
    expect(a.backend).toBeNull();
    expect(a.reason).toMatch(/privy\.ts/);
  });

  it("after registerPrivySdk the same env gives the privy backend", async () => {
    const b = await load({ appId: "app-1" });
    b.registerPrivySdk(fakeSdk());
    const a = b.activeBackend();
    expect(a.backend?.id).toBe("privy");
    expect(a.reason).toBeNull();
  });

  it("registerPrivySdk(null) puts it back to unavailable", async () => {
    const b = await load({ appId: "app-1" });
    b.registerPrivySdk(fakeSdk());
    b.registerPrivySdk(null);
    const a = b.activeBackend();
    expect(a.backend).toBeNull();
    expect(a.reason).toMatch(/privy\.ts/);
  });

  it("neither env var set is unavailable, and the reason names VITE_EMBEDDED_WALLET", async () => {
    const a = (await load()).activeBackend();
    expect(a.backend).toBeNull();
    expect(a.reason).toMatch(/VITE_EMBEDDED_WALLET/);
  });

  it("registering an SDK does not turn on a build that is off or mock", async () => {
    const off = await load();
    off.registerPrivySdk(fakeSdk());
    expect(off.activeBackend().backend).toBeNull();
    const mock = await load({ mode: "mock" });
    mock.registerPrivySdk(fakeSdk());
    expect(mock.activeBackend().backend?.id).toBe("mock");
  });
});
