import { afterEach, describe, expect, it, vi } from "vitest";

// mode.ts resolves env at module load, so each case sets env and re-imports.
async function load(env: { mode?: string; appId?: string } = {}) {
  vi.resetModules();
  vi.stubEnv("VITE_EMBEDDED_WALLET", env.mode ?? "");
  vi.stubEnv("VITE_EMBEDDED_WALLET_APP_ID", env.appId ?? "");
  return import("../mode");
}
afterEach(() => vi.unstubAllEnvs());

describe("EMBEDDED_MODE", () => {
  it("mock when asked for, with no app id needed", async () => {
    const m = await load({ mode: "mock" });
    expect(m.EMBEDDED_MODE).toBe("mock");
    expect(m.EMBEDDED_ENABLED).toBe(true);
    expect(m.EMBEDDED_IS_MOCK).toBe(true);
    expect(m.embeddedOffReason()).toBeNull();
  });

  it("the value is trimmed and case-insensitive", async () => {
    expect((await load({ mode: " MOCK " })).EMBEDDED_MODE).toBe("mock");
  });

  it("an app id with no explicit var turns privy on", async () => {
    const m = await load({ appId: "app-1" });
    expect(m.EMBEDDED_MODE).toBe("privy");
    expect(m.EMBEDDED_IS_MOCK).toBe(false);
    expect(m.EMBEDDED_APP_ID).toBe("app-1");
  });

  it("an explicit mock beats an app id", async () => {
    expect((await load({ mode: "mock", appId: "app-1" })).EMBEDDED_MODE).toBe("mock");
  });

  it("privy requested without an app id is off, and says which variable is missing", async () => {
    const m = await load({ mode: "privy" });
    expect(m.EMBEDDED_MODE).toBe("off");
    expect(m.embeddedOffReason()).toMatch(/VITE_EMBEDDED_WALLET_APP_ID/);
  });

  it("neither set is off (the pre-workstream behaviour), with a how-to-enable reason", async () => {
    const m = await load();
    expect(m.EMBEDDED_MODE).toBe("off");
    expect(m.EMBEDDED_ENABLED).toBe(false);
    expect(m.embeddedOffReason()).toMatch(/not configured/);
  });

  it("explicit off wins over an app id", async () => {
    const m = await load({ mode: "off", appId: "app-1" });
    expect(m.EMBEDDED_MODE).toBe("off");
    expect(m.embeddedOffReason()).toMatch(/switched off/);
  });

  it("an unrecognised value falls through to the app-id rule", async () => {
    expect((await load({ mode: "turnkey" })).EMBEDDED_MODE).toBe("off");
    expect((await load({ mode: "turnkey", appId: "x" })).EMBEDDED_MODE).toBe("privy");
  });
});
