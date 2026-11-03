import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localKeypair } from "@/lib/wallet";
import { privyBackend, rememberedEmail, type PrivySdk } from "../privy";
import { stubLocalStorage } from "./storage";

const publicKey = localKeypair("tenant").publicKey;
const signer = (over: object = {}) => ({
  publicKey,
  signTransaction: async (t: any) => t,
  signMessage: async (_m: Uint8Array) => new Uint8Array(64),
  ...over,
});

function fakeSdk(over: Partial<PrivySdk> = {}) {
  return {
    sendCode: vi.fn(async (_e: string) => {}),
    loginWithCode: vi.fn(async (_c: string) => {}),
    solanaWallet: vi.fn(async () => signer() as any),
    logout: vi.fn(async () => {}),
    ...over,
  } satisfies PrivySdk;
}

afterEach(() => vi.unstubAllGlobals());

describe("privyBackend", () => {
  beforeEach(() => {
    stubLocalStorage();
  });

  it("needs a code", () => expect(privyBackend(fakeSdk()).needsCode).toBe(true));

  it("start sends the code to the normalized email and returns null, not a wallet", async () => {
    const sdk = fakeSdk();
    expect(await privyBackend(sdk).start(" Foo@Bar.COM ", "tenant")).toBeNull();
    expect(sdk.sendCode).toHaveBeenCalledWith("foo@bar.com");
    expect(sdk.loginWithCode).not.toHaveBeenCalled();
    expect(rememberedEmail("tenant")).toBe("foo@bar.com");
  });

  it("start rejects a blank email without contacting Privy", async () => {
    const sdk = fakeSdk();
    await expect(privyBackend(sdk).start("  ", "tenant")).rejects.toThrow(/Enter an email/);
    expect(sdk.sendCode).not.toHaveBeenCalled();
  });

  it("start does not remember the email when sending fails", async () => {
    const sdk = fakeSdk({ sendCode: vi.fn(async () => Promise.reject(new Error("rate limited"))) });
    await expect(privyBackend(sdk).start("a@b.co", "tenant")).rejects.toThrow("rate limited");
    expect(rememberedEmail("tenant")).toBeNull();
  });

  it("submitCode logs in with the trimmed code and returns an embedded provider", async () => {
    const sdk = fakeSdk();
    const w = await privyBackend(sdk).submitCode(" 123456 ", "tenant");
    expect(sdk.loginWithCode).toHaveBeenCalledWith("123456");
    expect(w.kind).toBe("embedded");
    expect(w.publicKey).toBe(publicKey);
  });

  it("the returned provider carries the derivation guard", async () => {
    const raw = vi.fn(async (_m: Uint8Array) => new Uint8Array(64));
    const w = await privyBackend(fakeSdk({ solanaWallet: async () => signer({ signMessage: raw }) as any })).submitCode("1", "tenant");
    await expect(w.signMessage!(new TextEncoder().encode("solana-conf-bal/v1"))).rejects.toThrow(/refuses/);
    expect(raw).not.toHaveBeenCalled();
  });

  it("submitCode rejects a blank code without logging in", async () => {
    const sdk = fakeSdk();
    await expect(privyBackend(sdk).submitCode("  ", "tenant")).rejects.toThrow(/Enter the code/);
    expect(sdk.loginWithCode).not.toHaveBeenCalled();
  });

  it("rejects a signer that cannot sign messages instead of wrapping it", async () => {
    const sdk = fakeSdk({ solanaWallet: async () => signer({ signMessage: undefined }) as any });
    await expect(privyBackend(sdk).submitCode("1", "tenant")).rejects.toThrow(/cannot sign messages/);
    await expect(privyBackend(sdk).restore("tenant")).rejects.toThrow(/cannot sign messages/);
  });

  it("solanaWallet() null after login is reported as a missing Solana wallet", async () => {
    const sdk = fakeSdk({ solanaWallet: async () => null });
    await expect(privyBackend(sdk).submitCode("1", "tenant")).rejects.toThrow(/reported no Solana wallet/);
  });

  it("restore is null when nobody is logged in, a provider when someone is", async () => {
    expect(await privyBackend(fakeSdk({ solanaWallet: async () => null })).restore("tenant")).toBeNull();
    expect((await privyBackend(fakeSdk()).restore("tenant"))!.kind).toBe("embedded");
  });

  it("submitCode propagates a login failure", async () => {
    const sdk = fakeSdk({ loginWithCode: vi.fn(async () => Promise.reject(new Error("bad code"))) });
    await expect(privyBackend(sdk).submitCode("1", "tenant")).rejects.toThrow("bad code");
    expect(sdk.solanaWallet).not.toHaveBeenCalled();
  });

  it("signOut logs out of Privy and forgets the remembered email", async () => {
    const sdk = fakeSdk();
    const b = privyBackend(sdk);
    await b.start("a@b.co", "tenant");
    await b.signOut("tenant");
    expect(sdk.logout).toHaveBeenCalledTimes(1);
    expect(rememberedEmail("tenant")).toBeNull();
  });
});

describe("privyBackend without localStorage (node)", () => {
  it("still completes the flow; the email is just not shown back", async () => {
    expect(typeof localStorage).toBe("undefined");
    const b = privyBackend(fakeSdk());
    expect(await b.start("a@b.co", "tenant")).toBeNull();
    expect(rememberedEmail("tenant")).toBeNull();
    await expect(b.signOut("tenant")).resolves.toBeUndefined();
  });
});
