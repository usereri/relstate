import { describe, expect, it } from "vitest";
import { committedName, nameOf } from "../Mediation";
import type { AppraiserOption } from "@/lib/appraisers";

// Pure wrappers over lib/appraisers' trustedLabel / appraiserLabel, reachable with no DOM: the
// commit-site labels (pick, change, bind, submit) must fall back to the key for an unverified
// name, where the browse-site label (nameOf) still shows it.
const option = (overrides: Partial<AppraiserOption> = {}): AppraiserOption => ({
  address: "ADDR",
  wallet: "WALLETKEY123",
  name: "Rzeczoznawca A",
  nameVerified: true,
  active: true,
  isDefault: false,
  fee: 1_000,
  ...overrides,
});

describe("committedName", () => {
  it("shows the verified name on a commit-site label", () => {
    expect(committedName([option({ wallet: "W1" })], "W1")).toBe("Rzeczoznawca A");
  });

  it("falls back to the shortened key when the name is unverified, unlike nameOf", () => {
    const options = [option({ wallet: "W1", nameVerified: false })];
    expect(committedName(options, "W1")).toBe("W1");
    expect(nameOf(options, "W1")).toBe("Rzeczoznawca A"); // browse-site label still shows it
  });

  it("does not throw when the wallet is not in the options at all", () => {
    expect(() => committedName([option({ wallet: "W1" })], "UNKNOWNWALLET123")).not.toThrow();
  });

  it("does not throw while options are still loading", () => {
    expect(() => committedName(undefined, "WALLETKEY123")).not.toThrow();
  });
});
