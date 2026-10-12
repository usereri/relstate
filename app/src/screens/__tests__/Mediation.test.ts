import { describe, expect, it } from "vitest";
import { committedName, nameOf } from "../Mediation";
import type { AppraiserOption } from "@/lib/appraisers";
import { short } from "@/lib/utils";

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
    const wallet = "WALLETKEY123";
    const options = [option({ wallet, nameVerified: false })];
    expect(committedName(options, wallet)).toBe(short(wallet, 5));
    expect(nameOf(options, wallet)).toBe("Rzeczoznawca A"); // browse-site label still shows it
  });

  it("uses the shortened wallet when it is not in the options at all", () => {
    const wallet = "UNKNOWNWALLET123";
    expect(committedName([option({ wallet: "W1" })], wallet)).toBe(short(wallet, 5));
  });

  it("uses the shortened wallet while options are still loading", () => {
    const wallet = "WALLETKEY123";
    expect(committedName(undefined, wallet)).toBe(short(wallet, 5));
  });

  it("uses the shortened wallet for an empty options list", () => {
    const wallet = "WALLETKEY123";
    expect(committedName([], wallet)).toBe(short(wallet, 5));
  });
});
