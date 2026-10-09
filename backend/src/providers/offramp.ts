// Fiat out: a mocked payout. No money moves, in either mode.
//
// The real cash-out is MoneyGram, which settles on mainnet and is parked
// (docs/contracts/moneygram.md). So this is a stage prop with honest wiring: it
// prices the payout at the same demo rate as the on-ramp, goes through the
// treasury where it can, and labels every response `simulated` so nothing
// downstream can mistake it for a settlement.
//
// What it does *not* do is release the reserve on its own. `unwrap` burns rUSDC
// with the **owner's** signature and then releases the matching USDC; releasing
// without burning would leave `supply > reserve` — the one invariant the peg
// rests on (docs/contracts/treasury.md). So when nobody here holds the
// landlord's key, the receipt says the burn is still owed rather than quietly
// moving the reserve.
import { isAddress } from "@solana/kit";
import { randomUUID } from "node:crypto";
import type { TreasuryInvariantView } from "../contracts.ts";
import { reportForLog, type Treasury } from "../treasury.ts";
import { formatPln, formatUsdc, usdcToPln } from "./money.ts";
import { OnrampError, createDailyCap, formatRate } from "./onramp.ts";

export type OfframpTreasury = Pick<Treasury, "mode" | "unwrap" | "invariant">;

export type PayoutReceipt = {
  /** Always true for the demo. The UI prints it; do not remove it. */
  simulated: true;
  reference: string;
  wallet: string;
  /** Base units. */
  amountUsdc: string;
  /** Grosz. */
  amountPln: string;
  plnPerUsdc: string;
  method: string;
  /** Where the money would have gone, as the landlord typed it. Never stored beyond this response. */
  destination: string | null;
  status: "paid-simulated";
  /** What actually happened on chain, if anything. */
  unwrap: {
    burned: boolean;
    signatures: string[];
    /** Why the burn did not happen, when it did not. */
    note: string;
    invariant?: TreasuryInvariantView;
  };
  at: number;
};

export type OfframpConfig = {
  rateScaled: bigint;
  /** Base units per wallet per rolling day. */
  maxUsdcPerWalletPerDay: bigint;
};

export type OfframpDeps = {
  config: OfframpConfig;
  /** Lazy, and allowed to fail: a fresh clone with no rUSDC mint still shows the payout screen. */
  treasury?: () => Promise<OfframpTreasury>;
  /**
   * Test and scripted-devnet seam, as in the on-ramp. Token-2022 `Burn` is
   * authorised by the token owner, so only a path that holds the landlord's
   * signer can actually unwrap; in the app the landlord signs it themselves.
   */
  resolveOwner?: (wallet: string) => Promise<Parameters<Treasury["unwrap"]>[0]["owner"] | null>;
  log?: (...args: unknown[]) => void;
  now?: () => number;
};

const NO_KEY_NOTE =
  "No burn: rUSDC is burnt with the landlord's own signature, which this backend does not hold. " +
  "The reserve is therefore untouched and the peg invariant still holds. This receipt is a stage prop.";

export function createOfframp(deps: OfframpDeps) {
  const { config } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const cap = createDailyCap(config.maxUsdcPerWalletPerDay);
  const receipts = new Map<string, PayoutReceipt>();

  /**
   * `wallet` comes from the session token. The amount is the landlord's to
   * choose — it is their own balance being paid out — but it is still capped per
   * wallet per day, so a stolen session cannot drain the reserve in live mode.
   */
  async function payout({
    wallet,
    amountUsdc,
    method = "bank-transfer",
    destination = null,
  }: {
    wallet: string;
    amountUsdc: bigint;
    method?: string;
    destination?: string | null;
  }): Promise<PayoutReceipt> {
    if (!isAddress(wallet)) throw new OnrampError(`${wallet} is not a valid wallet address`, "malformed-wallet");
    if (amountUsdc <= 0n) throw new OnrampError("payout amount must be positive", "amount-out-of-range");
    cap.check(wallet, amountUsdc, now());

    let unwrap: PayoutReceipt["unwrap"] = { burned: false, signatures: [], note: NO_KEY_NOTE };
    if (deps.treasury !== undefined && deps.resolveOwner !== undefined) {
      const treasury = await deps.treasury();
      const owner = await deps.resolveOwner(wallet);
      if (owner !== null) {
        const result = await treasury.unwrap({ owner, amount: amountUsdc, ref: "offramp" });
        unwrap = {
          burned: true,
          signatures: result.signatures,
          note: "Burnt from the public rUSDC balance and released from the reserve. The fiat leg is still simulated.",
          invariant: reportForLog(result.invariantAfter),
        };
      }
    }

    cap.record(wallet, amountUsdc, now());
    const receipt: PayoutReceipt = {
      simulated: true,
      reference: `SIM-${randomUUID().slice(0, 8).toUpperCase()}`,
      wallet,
      amountUsdc: amountUsdc.toString(),
      amountPln: usdcToPln(amountUsdc, config.rateScaled).toString(),
      plnPerUsdc: formatRate(config.rateScaled),
      method,
      // Truncated, never logged: an IBAN typed on stage is still somebody's IBAN.
      destination: destination === null || destination.trim() === "" ? null : destination.trim().slice(0, 64),
      status: "paid-simulated",
      unwrap,
      at: now(),
    };
    receipts.set(receipt.reference, receipt);
    log(
      `offramp: SIMULATED payout ${receipt.reference} of ${formatUsdc(amountUsdc)} rUSDC ` +
        `(~${formatPln(BigInt(receipt.amountPln))} PLN) for ${wallet}; burned=${unwrap.burned}`,
    );
    return receipt;
  }

  return {
    payout,
    receipt: (reference: string): PayoutReceipt | undefined => receipts.get(reference),
    history: (wallet: string): PayoutReceipt[] => [...receipts.values()].filter((r) => r.wallet === wallet).sort((a, b) => b.at - a.at),
    remainingToday: (wallet: string): bigint => cap.remaining(wallet, now()),
    cap: config.maxUsdcPerWalletPerDay,
    rateScaled: config.rateScaled,
  };
}

export type Offramp = ReturnType<typeof createOfframp>;
