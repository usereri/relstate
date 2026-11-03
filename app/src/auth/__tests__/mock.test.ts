import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { CONFIDENTIAL_DERIVATION_MESSAGE as MSG, localKeypair, localWallet } from "@/lib/wallet";
import { forgetEmail, mockAddressFor, mockBackend, mockKeypair, mockWalletFor, storedEmail } from "../mock";
import { stubLocalStorage } from "./storage";

afterEach(() => vi.unstubAllGlobals());

describe("mock embedded wallet derivation", () => {
  it("is deterministic for the same email", () => {
    expect(mockKeypair("a@b.co").publicKey.toBase58()).toBe(mockKeypair("a@b.co").publicKey.toBase58());
  });

  it("normalizes the email: case and surrounding space are the same wallet", () => {
    expect(mockAddressFor(" Foo@Bar.COM ")).toBe(mockAddressFor("foo@bar.com"));
  });

  it("different emails are different wallets", () => {
    expect(mockAddressFor("a@b.co")).not.toBe(mockAddressFor("c@d.co"));
  });

  it("mockAddressFor agrees with mockWalletFor", () => {
    const w = mockWalletFor("demo@relstate.xyz");
    expect(w.kind).toBe("embedded");
    expect(w.publicKey.toBase58()).toBe(mockAddressFor("demo@relstate.xyz"));
  });

  // A prepared demo funds this address ahead of time; silent derivation drift would unfund it.
  it("demo@relstate.xyz stays put", () => expect(mockAddressFor("demo@relstate.xyz")).toBe("FfjQ7cXUzjv38fkixGmC27sCtoUfjTtwKZsduAd7GRk7"));

  it("is not the local test wallet's key", () => {
    expect(mockAddressFor("tenant")).not.toBe(localKeypair("tenant").publicKey.toBase58());
  });

  it("derives the same confidential key material as a local wallet for the same keypair", async () => {
    const kp = mockKeypair("demo@relstate.xyz");
    const sig = await mockWalletFor("demo@relstate.xyz").deriveConfidentialKeyMaterial!();
    expect(ed25519.verify(sig, MSG, kp.publicKey.toBytes())).toBe(true);
    // sanity that the comparison is meaningful: a different keypair signs differently
    expect(Array.from(sig)).not.toEqual(Array.from(await localWallet("tenant").deriveConfidentialKeyMaterial!()));
  });
});

describe("mockBackend", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = stubLocalStorage();
  });

  it("is the mock, with no code step", () => {
    expect(mockBackend.id).toBe("mock");
    expect(mockBackend.needsCode).toBe(false);
  });

  it("restore is null when nothing is stored", async () => {
    expect(await mockBackend.restore("tenant")).toBeNull();
  });

  it("start returns the wallet for the normalized email and restore brings the same one back", async () => {
    const w = await mockBackend.start(" Foo@Bar.COM ", "tenant");
    expect(w!.publicKey.toBase58()).toBe(mockAddressFor("foo@bar.com"));
    expect(storedEmail("tenant")).toBe("foo@bar.com");
    expect((await mockBackend.restore("tenant"))!.publicKey.toBase58()).toBe(w!.publicKey.toBase58());
  });

  it("keeps each role's account separate", async () => {
    await mockBackend.start("a@b.co", "tenant");
    expect(await mockBackend.restore("landlord")).toBeNull();
  });

  it("signOut forgets the account", async () => {
    await mockBackend.start("a@b.co", "tenant");
    await mockBackend.signOut("tenant");
    expect(await mockBackend.restore("tenant")).toBeNull();
    expect(store.size).toBe(0);
  });

  it("start rejects an empty or blank email and stores nothing", async () => {
    await expect(mockBackend.start("", "tenant")).rejects.toThrow(/Enter an email/);
    await expect(mockBackend.start("   ", "tenant")).rejects.toThrow(/Enter an email/);
    expect(store.size).toBe(0);
  });

  it("submitCode rejects: the mock sends no code", async () => {
    await expect(mockBackend.submitCode("123456", "tenant")).rejects.toThrow(/does not send a confirmation code/);
  });

  it("storedEmail ignores corrupt or wrong-shaped storage", () => {
    store.set("relstate.embedded.tenant", "not json");
    expect(storedEmail("tenant")).toBeNull();
    store.set("relstate.embedded.tenant", JSON.stringify({ email: 5 }));
    expect(storedEmail("tenant")).toBeNull();
    store.set("relstate.embedded.tenant", JSON.stringify({ email: "" }));
    expect(storedEmail("tenant")).toBeNull();
  });
});

describe("mockBackend without localStorage (node)", () => {
  // Pins graceful degradation: private mode / no storage must not break sign-in, only persistence.
  it("start still yields a wallet, restore is null, signOut does not throw", async () => {
    vi.unstubAllGlobals();
    expect(typeof localStorage).toBe("undefined");
    const w = await mockBackend.start("a@b.co", "tenant");
    expect(w!.publicKey.toBase58()).toBe(mockAddressFor("a@b.co"));
    expect(await mockBackend.restore("tenant")).toBeNull();
    await expect(mockBackend.signOut("tenant")).resolves.toBeUndefined();
    expect(() => forgetEmail("tenant")).not.toThrow();
  });
});
