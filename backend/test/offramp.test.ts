import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OnrampError } from "../src/providers/onramp.ts";
import { createOfframp, type OfframpTreasury } from "../src/providers/offramp.ts";
import { parseRate, parseUsdc } from "../src/providers/money.ts";

const WALLET = "EBMibFLTvr5GDpgxNqt5Gqp9B1xLMr32aNwGDJV2oGJ6";
const OTHER = "11111111111111111111111111111111";

const config = (cap = "2000") => ({ rateScaled: parseRate("4.30"), maxUsdcPerWalletPerDay: parseUsdc(cap) });

const report = { supply: 0n, reserve: 0n, ok: true, headroom: 0n, reserveSource: "mock-ledger" as const };
function fakeTreasury() {
  const unwraps: Array<{ owner: unknown; amount: bigint; ref?: string }> = [];
  const treasury = {
    mode: "mock" as const,
    async unwrap(args: { owner: unknown; amount: bigint; ref?: string }) {
      unwraps.push(args);
      return { token: WALLET, signatures: ["sig-unwrap"], invariantAfter: report };
    },
    async invariant() {
      return report;
    },
  };
  return { treasury: treasury as unknown as OfframpTreasury, unwraps };
}

describe("offramp.payout", () => {
  it("returns a simulated receipt priced at the demo rate", async () => {
    const off = createOfframp({ config: config(), now: () => 1000 });
    const receipt = await off.payout({ wallet: WALLET, amountUsdc: parseUsdc("93.023255") });
    assert.equal(receipt.simulated, true);
    assert.equal(receipt.status, "paid-simulated");
    assert.match(receipt.reference, /^SIM-[0-9A-F]{8}$/);
    assert.equal(receipt.wallet, WALLET);
    assert.equal(receipt.amountUsdc, "93023255");
    assert.equal(receipt.amountPln, "40000");
    assert.equal(receipt.plnPerUsdc, "4.30");
    assert.equal(receipt.method, "bank-transfer");
    assert.equal(receipt.at, 1000);
    assert.equal(off.receipt(receipt.reference), receipt);
  });

  it("burns nothing and says why when no owner signer is available", async () => {
    const t = fakeTreasury();
    const off = createOfframp({ config: config(), treasury: async () => t.treasury });
    const receipt = await off.payout({ wallet: WALLET, amountUsdc: 1_000_000n });
    assert.equal(receipt.unwrap.burned, false);
    assert.deepEqual(receipt.unwrap.signatures, []);
    assert.match(receipt.unwrap.note, /No burn/);
    assert.match(receipt.unwrap.note, /peg invariant still holds/);
    assert.equal(t.unwraps.length, 0);
  });

  it("burns through the treasury when the owner's signer is available", async () => {
    const t = fakeTreasury();
    const owner = { address: WALLET };
    const off = createOfframp({
      config: config(),
      treasury: async () => t.treasury,
      resolveOwner: async (wallet) => (wallet === WALLET ? (owner as never) : null),
    });
    const burned = await off.payout({ wallet: WALLET, amountUsdc: 5_000_000n });
    assert.equal(burned.unwrap.burned, true);
    assert.deepEqual(burned.unwrap.signatures, ["sig-unwrap"]);
    assert.equal(burned.simulated, true, "the fiat leg is still simulated");
    assert.equal(t.unwraps.length, 1);
    assert.equal(t.unwraps[0]!.amount, 5_000_000n);

    const notBurned = await off.payout({ wallet: OTHER, amountUsdc: 5_000_000n });
    assert.equal(notBurned.unwrap.burned, false);
    assert.equal(t.unwraps.length, 1);
  });

  it("respects its own daily cap", async () => {
    const off = createOfframp({ config: config("10") });
    await off.payout({ wallet: WALLET, amountUsdc: parseUsdc("6") });
    await assert.rejects(
      () => off.payout({ wallet: WALLET, amountUsdc: parseUsdc("5") }),
      (e: unknown) => e instanceof OnrampError && e.code === "wallet-cap" && e.status === 429,
    );
    assert.equal(off.remainingToday(WALLET), parseUsdc("4"));
    // another wallet has its own allowance
    await off.payout({ wallet: OTHER, amountUsdc: parseUsdc("10") });
  });

  it("the cap window expires", async () => {
    let clock = 0;
    const off = createOfframp({ config: config("10"), now: () => clock });
    await off.payout({ wallet: WALLET, amountUsdc: parseUsdc("10") });
    clock = 86_400_001;
    await off.payout({ wallet: WALLET, amountUsdc: parseUsdc("10") });
  });

  it("a refused payout does not use up the cap", async () => {
    const off = createOfframp({ config: config("10") });
    await assert.rejects(() => off.payout({ wallet: WALLET, amountUsdc: parseUsdc("11") }));
    assert.equal(off.remainingToday(WALLET), parseUsdc("10"));
  });

  it("rejects a zero or negative amount", async () => {
    const off = createOfframp({ config: config() });
    for (const amount of [0n, -1n]) {
      await assert.rejects(
        () => off.payout({ wallet: WALLET, amountUsdc: amount }),
        (e: unknown) => e instanceof OnrampError && e.code === "amount-out-of-range",
      );
    }
  });

  it("rejects a wallet that is not an address", async () => {
    const off = createOfframp({ config: config() });
    await assert.rejects(
      () => off.payout({ wallet: "nope", amountUsdc: 1n }),
      (e: unknown) => e instanceof OnrampError && e.code === "malformed-wallet",
    );
  });

  it("truncates the destination and treats blank as none", async () => {
    const off = createOfframp({ config: config() });
    const long = await off.payout({ wallet: WALLET, amountUsdc: 1_000_000n, destination: ` ${"x".repeat(100)} ` });
    assert.equal(long.destination?.length, 64);
    const blank = await off.payout({ wallet: WALLET, amountUsdc: 1_000_000n, destination: "   " });
    assert.equal(blank.destination, null);
  });

  it("never logs the destination", async () => {
    const lines: string[] = [];
    const off = createOfframp({ config: config(), log: (...args) => lines.push(args.join(" ")) });
    await off.payout({ wallet: WALLET, amountUsdc: 1_000_000n, destination: "PL61109010140000071219812874" });
    assert.ok(lines.length > 0);
    assert.ok(!lines.join("\n").includes("PL61109010140000071219812874"));
  });
});

describe("offramp.history", () => {
  it("lists only the asked wallet's receipts, newest first", async () => {
    let clock = 0;
    const off = createOfframp({ config: config(), now: () => ++clock });
    const a1 = await off.payout({ wallet: WALLET, amountUsdc: 1_000_000n });
    await off.payout({ wallet: OTHER, amountUsdc: 2_000_000n });
    const a2 = await off.payout({ wallet: WALLET, amountUsdc: 3_000_000n });
    assert.deepEqual(off.history(WALLET).map((r) => r.reference), [a2.reference, a1.reference]);
    assert.equal(off.history(OTHER).length, 1);
    assert.deepEqual(off.history("nobody"), []);
  });
});
