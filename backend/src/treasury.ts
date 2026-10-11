// Contract 6: the rUSDC treasury.
//
// rUSDC is pegged 1:1 to devnet test USDC and the peg is a custodial promise
// backed by a reserve we control (docs/contracts/treasury.md says so out loud).
// The one invariant that makes the promise meaningful is:
//
//     rUSDC supply <= reserve USDC balance
//
// It is checked before every mint and after every burn, so a wrap can never
// outrun the reserve and an unwrap can never leave the reserve short.
//
// In mock mode the reserve is an in-memory ledger instead of a real USDC
// account: the USDC leg is skipped, but rUSDC is still minted and burnt for
// real and the invariant is still enforced against the ledger. A wrap in mock
// mode therefore still fails if the reserve was never credited — the check is
// not short-circuited just because the money is imaginary.
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMaybeToken,
  fetchMint,
  getBurnInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction,
} from "@solana-program/token-2022";
import {
  sequentialInstructionPlan,
  type Address,
  type GetAccountInfoApi,
  type GetBalanceApi,
  type GetMinimumBalanceForRentExemptionApi,
  type GetTokenAccountBalanceApi,
  type KeyPairSigner,
  type Rpc,
  type SendTransactionApi,
  type Signature,
  type SimulateTransactionApi,
  type TransactionSigner,
} from "@solana/kit";
import {
  assertIsFullySignedTransaction,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  partiallySignTransaction,
} from "@solana/kit";
import {
  associatedTokenAddress,
  depositAndApply,
  ensureConfidentialAccount,
  type ConfidentialRpc,
  type RunPlan,
} from "./confidential.ts";
import { env } from "./env.ts";
import type { ConfidentialKeyPair } from "./keys.ts";
import { ZK_ELGAMAL_PROOF_PROGRAM } from "./contracts.ts";
import { accountLayout, type Layout } from "./layout.ts";
import { contextUse, createRentPlanRegistry } from "./rentplan.ts";
import { RANGE_PROOF_CONTEXT_SPACE, RENT_PAYMENT_ALLOWLIST, assertRentPaymentShape } from "./rentshape.ts";
import { getTransferSolInstruction } from "@solana-program/system";
import { createHash } from "node:crypto";
import {
  COMPUTE_BUDGET_PROGRAM,
  RejectedTransaction,
  assertOnlySponsorSignatureMissing,
  assertPresentSignaturesValid,
  assertComputeBudgetWithinPolicy,
  assertProgramsAllowed,
  inspectTransaction,
  type InspectedTransaction,
} from "./txinspect.ts";
import { createRateLimiter, LimitError, type RateLimiter } from "./limits.ts";

export type TreasuryRpc = Rpc<
  GetAccountInfoApi & GetBalanceApi & GetMinimumBalanceForRentExemptionApi & GetTokenAccountBalanceApi & SimulateTransactionApi & SendTransactionApi
>;

/** The send errored in a way that does not prove the transaction failed to land. */
export class SendOutcomeUnknown extends RejectedTransaction {
  readonly signature: Signature;
  constructor(signature: Signature, cause: unknown) {
    super(`sending ${signature} failed; it may still land, check its status before retrying`, "send-outcome-unknown");
    void cause; // the RPC error text stays in the server log, never in the response
    this.signature = signature;
  }
}
const isKnownNotLanded = (e: unknown): boolean => e instanceof Error && /blockhash not found|blockhash.*expired|block height exceeded/i.test(e.message);

export class InvariantViolation extends Error {
  readonly supply: bigint;
  readonly reserve: bigint;
  readonly attempted: bigint;
  constructor(supply: bigint, reserve: bigint, attempted: bigint) {
    super(
      `reserve invariant would break: supply ${supply} + ${attempted} > reserve ${reserve}. ` +
        "Credit the reserve from a confirmed on-ramp deposit before minting rUSDC.",
    );
    this.supply = supply;
    this.reserve = reserve;
    this.attempted = attempted;
  }
}

export type InvariantReport = {
  supply: bigint;
  reserve: bigint;
  ok: boolean;
  /** How much more rUSDC could be minted before the invariant breaks. */
  headroom: bigint;
  reserveSource: "onchain" | "mock-ledger";
};

/**
 * Programs allowed in a treasury-sponsored confidential-account setup.
 *
 * Narrower than the sponsor allowlist, and deliberately without the System
 * program. This is the one path where our key is a *writable signer inside*
 * instructions (it funds the account's rent), so a System transfer here would
 * be a direct drain. The setup plan built by
 * `getCreateConfidentialTransferAccountInstructionPlan` needs only these four
 * programs — verified against the plan itself — and the lamport-delta cap below
 * bounds the cost on top.
 */
export const CONFIDENTIAL_SETUP_ALLOWLIST = [
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  ZK_ELGAMAL_PROOF_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
] as const;

const TOKEN_2022_REALLOCATE = 29;
const TOKEN_2022_CONFIDENTIAL_TRANSFER = 27;
const CT_CONFIGURE_ACCOUNT = 2;
const ATA_CREATE = 0;
const ATA_CREATE_IDEMPOTENT = 1;

/**
 * Instruction-shape filter for the treasury-cosigned setup transaction.
 *
 * The treasury key is the rUSDC mint authority, so allowlisting the Token-2022
 * program is not enough: MintTo, CloseAccount and FreezeAccount are all
 * Token-2022 instructions. Only the exact instructions an account setup needs
 * pass, and the treasury may appear only as a rent payer, never as an
 * authority.
 */
export function assertConfidentialSetupShape(tx: InspectedTransaction, treasury: string): void {
  const deny = (index: number, why: string): never => {
    throw new RejectedTransaction(`instruction ${index}: ${why}`, "instruction-not-allowed");
  };
  for (const ix of tx.instructions) {
    const treasuryAt = ix.accounts.findIndex((a) => a.address === treasury);
    if (ix.programAddress === TOKEN_2022_PROGRAM_ADDRESS) {
      const tag = ix.data[0];
      const isReallocate = tag === TOKEN_2022_REALLOCATE;
      const isConfigure = tag === TOKEN_2022_CONFIDENTIAL_TRANSFER && ix.data[1] === CT_CONFIGURE_ACCOUNT;
      if (!isReallocate && !isConfigure) deny(ix.index, `Token-2022 instruction tag ${tag} is not permitted`);
      // Reallocate: [account, payer, system, owner, ...]. The payer slot is the only place the treasury may be.
      if (treasuryAt !== -1 && !(isReallocate && ix.accounts.filter((a) => a.address === treasury).length === 1 && treasuryAt === 1)) {
        deny(ix.index, "the treasury may only fund Reallocate rent, not appear elsewhere in Token-2022 instructions");
      }
    } else if (ix.programAddress === ASSOCIATED_TOKEN_PROGRAM_ADDRESS) {
      const tag = ix.data.length === 0 ? ATA_CREATE : ix.data[0];
      if (tag !== ATA_CREATE && tag !== ATA_CREATE_IDEMPOTENT) deny(ix.index, `associated-token instruction tag ${tag} is not permitted`);
      // [funder, ata, wallet, mint, system, token program]: funder only.
      if (ix.accounts.filter((a) => a.address === treasury).some((_, i) => i > 0) || (treasuryAt !== -1 && treasuryAt !== 0)) {
        deny(ix.index, "the treasury may only be the funder of an associated token account");
      }
    } else if (ix.programAddress === ZK_ELGAMAL_PROOF_PROGRAM) {
      // Proof verification and context-state accounts: no token authority is conferred.
    } else if (ix.programAddress !== COMPUTE_BUDGET_PROGRAM) {
      deny(ix.index, "program not permitted");
    }
  }
}

export type TreasuryDeps = {
  rpc: TreasuryRpc;
  run: RunPlan;
  /** rUSDC mint + freeze authority, and the only key that funds rent. */
  treasury: KeyPairSigner;
  mint: Address;
  decimals: number;
  mode: "mock" | "live";
  /** Treasury-owned devnet USDC account backing the peg. Required in live mode. */
  reserveTokenAccount?: Address;
  maxRentLamports?: bigint;
  /** Per-wallet and global caps for the setup route. Defaults are deliberately tight. */
  setupLimiter?: RateLimiter;
  /** Same, for the rent-payment and rent-dust routes. Tests inject their own. */
  rentPaymentLimiter?: RateLimiter;
  rentDustLimiter?: RateLimiter;
  /** Test seam for the account layouts rent dust sizes itself from; defaults to the program's IDL. */
  accountLayout?: (account: string) => Layout;
  log?: (...args: unknown[]) => void;
};

/**
 * How much of a wrapped amount may go confidential, given how much must stay
 * public for `fund_deposit`. Separate and pure because getting it wrong leaves a
 * tenant unable to accept a lease, with an "insufficient funds" error several
 * steps away from the cause.
 */
export function confidentialMoveAmount(total: bigint, publicHoldback: bigint): bigint {
  if (publicHoldback < 0n) throw new Error("publicHoldback cannot be negative");
  if (publicHoldback > total) {
    throw new Error(`publicHoldback ${publicHoldback} exceeds the wrapped amount ${total}; the deposit could never be funded`);
  }
  return total - publicHoldback;
}

export function createTreasury(deps: TreasuryDeps) {
  const log = deps.log ?? (() => {});
  const maxRentLamports = deps.maxRentLamports ?? env.sponsor.maxRentLamports;
  const setupLimiter =
    deps.setupLimiter ??
    createRateLimiter({
      maxPerWalletPerHour: 3,
      maxGlobalPerHour: 60,
      maxLamportsPerWalletPerDay: 3n * (maxRentLamports + env.sponsor.maxFeeLamports),
      maxLamportsGlobalPerDay: 20n * (maxRentLamports + env.sponsor.maxFeeLamports),
    });
  /**
   * Mock-mode stand-in for the real USDC reserve.
   *
   * Seeded from the mint's on-chain supply on first read, because the supply
   * outlives this process and the ledger does not. Without that, restarting
   * against a mint that already has rUSDC in circulation reports an invariant
   * violation that says nothing about this run. Seeded this way the invariant
   * starts at exactly zero headroom, so every new wrap still has to be backed
   * by a fresh credit — which is the property worth enforcing.
   */
  let mockReserve = 0n;
  /**
   * The seeding promise, not a boolean: two concurrent `reserve()` calls would
   * both pass a flag that is only set after the `await`, and both add the
   * supply. `invariant()` is reachable from a route, so that race is real.
   */
  let mockReserveSeeding: Promise<void> | undefined;
  const ledger: Array<{ at: number; kind: "credit" | "debit" | "wrap" | "unwrap"; amount: bigint; ref: string }> = [];

  async function supply(): Promise<bigint> {
    return (await fetchMint(deps.rpc, deps.mint)).data.supply;
  }

  async function reserve(): Promise<bigint> {
    if (deps.mode === "mock") {
      // `+=`, so a credit made before the first read is not lost.
      mockReserveSeeding ??= supply().then((onchain) => {
        mockReserve += onchain;
      });
      await mockReserveSeeding;
      return mockReserve;
    }
    if (deps.reserveTokenAccount === undefined) {
      throw new Error("USDC_RESERVE_TOKEN_ACCOUNT is required when BACKEND_MODE=live");
    }
    const balance = await deps.rpc.getTokenAccountBalance(deps.reserveTokenAccount).send();
    return BigInt(balance.value.amount);
  }

  async function invariant(): Promise<InvariantReport> {
    const [currentSupply, currentReserve] = await Promise.all([supply(), reserve()]);
    return {
      supply: currentSupply,
      reserve: currentReserve,
      ok: currentSupply <= currentReserve,
      headroom: currentReserve - currentSupply,
      reserveSource: deps.mode === "mock" ? "mock-ledger" : "onchain",
    };
  }

  /** Throws `InvariantViolation` unless `supply + additional <= reserve`. */
  async function assertInvariant(additional = 0n): Promise<InvariantReport> {
    const report = await invariant();
    if (report.supply + additional > report.reserve) {
      throw new InvariantViolation(report.supply, report.reserve, additional);
    }
    return report;
  }

  /**
   * Records USDC arriving in the reserve. In live mode the USDC really moved and
   * this only logs; in mock mode it is what gives the virtual reserve a balance,
   * standing in for the on-ramp webhook (workstream C owns the real one).
   */
  function creditReserve(amount: bigint, ref = "manual"): bigint {
    if (amount <= 0n) throw new Error("reserve credit must be positive");
    if (deps.mode === "mock") mockReserve += amount;
    ledger.push({ at: Date.now(), kind: "credit", amount, ref });
    log(`treasury: reserve credited ${amount} (${ref})`);
    return deps.mode === "mock" ? mockReserve : amount;
  }

  /**
   * Releases USDC from the reserve toward the off-ramp. Mocked for the demo in
   * both modes: no real payout provider is wired up yet (workstream E), so live
   * mode logs the obligation rather than pretending to settle it.
   */
  function releaseReserve(amount: bigint, ref = "manual"): bigint {
    if (amount <= 0n) throw new Error("reserve release must be positive");
    if (deps.mode === "mock") {
      if (amount > mockReserve) throw new Error(`reserve release ${amount} exceeds the reserve ${mockReserve}`);
      mockReserve -= amount;
    } else {
      log(`treasury: TODO(workstream E) release ${amount} USDC from the reserve to the off-ramp (${ref})`);
    }
    ledger.push({ at: Date.now(), kind: "debit", amount, ref });
    return deps.mode === "mock" ? mockReserve : amount;
  }

  /**
   * Wrap (on-ramp leg): mint `amount` rUSDC to `wallet`'s public rUSDC balance,
   * creating the token account if this is the wallet's first use.
   *
   * The balance lands public; making it confidential needs the wallet's own keys
   * (deposit + apply pending), which the app does over a sponsored transaction.
   */
  async function wrap({ wallet, amount, ref = "wrap" }: { wallet: Address; amount: bigint; ref?: string }): Promise<{
    token: Address;
    signatures: Signature[];
    invariantBefore: InvariantReport;
    invariantAfter: InvariantReport;
  }> {
    if (amount <= 0n) throw new Error("wrap amount must be positive");
    const invariantBefore = await assertInvariant(amount);

    const token = await associatedTokenAddress(wallet, deps.mint);
    const createAta = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: deps.treasury,
      owner: wallet,
      mint: deps.mint,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    const signatures = await deps.run(
      deps.treasury,
      sequentialInstructionPlan([
        createAta,
        getMintToInstruction(
          { mint: deps.mint, token, mintAuthority: deps.treasury, amount },
          { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
        ),
      ]),
      `wrap ${amount} rUSDC to ${wallet}`,
    );

    ledger.push({ at: Date.now(), kind: "wrap", amount, ref });
    const invariantAfter = await invariant();
    if (!invariantAfter.ok) log(`treasury: WARNING invariant broken after wrap: ${JSON.stringify(reportForLog(invariantAfter))}`);
    return { token, signatures, invariantBefore, invariantAfter };
  }

  /**
   * Unwrap (payout leg): burn `amount` rUSDC from the owner's public balance,
   * then release the matching USDC from the reserve.
   *
   * The owner must sign. The treasury is the mint and freeze authority but not
   * the token owner, and Token-2022 `Burn` is authorised by the owner — by
   * design, so a custodial backend cannot unilaterally destroy a user's balance.
   * A confidential balance must be withdrawn to the public balance first
   * (`confidentialWithdraw`).
   */
  async function unwrap({ owner, amount, ref = "unwrap" }: { owner: TransactionSigner; amount: bigint; ref?: string }): Promise<{
    token: Address;
    signatures: Signature[];
    invariantAfter: InvariantReport;
  }> {
    if (amount <= 0n) throw new Error("unwrap amount must be positive");
    const token = await associatedTokenAddress(owner.address, deps.mint);
    const existing = await fetchMaybeToken(deps.rpc, token);
    if (!existing.exists) throw new Error(`${owner.address} has no rUSDC account`);

    // Check the reserve can cover the release *before* burning. The burn is
    // irreversible, so discovering afterwards that the reserve is short would
    // leave supply and reserve permanently inconsistent.
    const available = await reserve();
    if (amount > available) {
      throw new Error(`unwrap ${amount} exceeds the reserve ${available}; refusing to burn against a reserve that cannot pay out`);
    }

    const signatures = await deps.run(
      deps.treasury,
      sequentialInstructionPlan([
        getBurnInstruction(
          { account: token, mint: deps.mint, authority: owner, amount },
          { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
        ),
      ]),
      `unwrap ${amount} rUSDC from ${owner.address}`,
    );

    // Burn first, release second: in that order the invariant is never violated
    // in between, because supply drops before the reserve does.
    ledger.push({ at: Date.now(), kind: "unwrap", amount, ref });
    releaseReserve(amount, ref);
    const invariantAfter = await invariant();
    if (!invariantAfter.ok) log(`treasury: WARNING invariant broken after unwrap: ${JSON.stringify(reportForLog(invariantAfter))}`);
    return { token, signatures, invariantAfter };
  }

  /**
   * First-use setup when the backend holds the owner's key (tests, scripted
   * devnet runs). The app path is `sponsorConfidentialAccountSetup` below,
   * where the wallet signs and we only pay.
   */
  async function ensureAccount(owner: TransactionSigner, keys: ConfidentialKeyPair) {
    return ensureConfidentialAccount({
      run: deps.run,
      rpc: deps.rpc as ConfidentialRpc,
      payer: deps.treasury,
      owner,
      mint: deps.mint,
      keys,
    });
  }

  /**
   * Wrap, then move the balance into the confidential side **except** for
   * `publicHoldback`.
   *
   * The holdback is not an optimisation. Only rent is confidential: the deposit
   * vault is a PDA-owned token account and a PDA cannot hold ElGamal keys, so
   * `fund_deposit` moves a **public** amount with `transfer_checked`
   * (docs/contracts/program-interface.md §5). A tenant whose whole balance went
   * confidential cannot accept a lease — the transfer into the vault fails with
   * insufficient funds. So the lease deposit stays public from the start rather
   * than being withdrawn back later, which would cost an extra proof plan.
   *
   * Needs the owner's key, because `Deposit` and `ApplyPendingBalance` are
   * owner-signed and `ApplyPendingBalance` re-encrypts the new balance locally.
   * In the app the wallet signs these over sponsored transactions; this path
   * covers tests and the scripted devnet run.
   */
  async function wrapAndMakeConfidential({
    owner,
    amount,
    publicHoldback = 0n,
    keys,
    ref = "wrap",
  }: {
    owner: TransactionSigner;
    amount: bigint;
    /** Keep this much public, e.g. `lease.deposit_amount`. */
    publicHoldback?: bigint;
    keys: ConfidentialKeyPair;
    ref?: string;
  }): Promise<{ token: Address; confidentialAmount: bigint; publicRemaining: bigint; invariantAfter: InvariantReport }> {
    const confidentialAmount = confidentialMoveAmount(amount, publicHoldback);
    const wrapped = await wrap({ wallet: owner.address, amount, ref });
    await ensureAccount(owner, keys);
    if (confidentialAmount > 0n) {
      await depositAndApply({
        run: deps.run,
        rpc: deps.rpc as ConfidentialRpc,
        payer: deps.treasury,
        owner,
        token: wrapped.token,
        mint: deps.mint,
        amount: confidentialAmount,
        decimals: deps.decimals,
        keys,
      });
    }
    log(`treasury: wrapped ${amount}, ${confidentialAmount} confidential, ${publicHoldback} held back public for fund_deposit`);
    return {
      token: wrapped.token,
      confidentialAmount,
      publicRemaining: publicHoldback,
      invariantAfter: wrapped.invariantAfter,
    };
  }

  /**
   * Co-signs a wallet-built confidential-account setup transaction, paying both
   * the fee and the account rent from the treasury key.
   *
   * This is the one sponsored path where our key is writable inside
   * instructions, which `/api/sponsor` forbids outright. It is safe here only
   * because the exposure is pinned on three sides: a four-program allowlist with
   * no System program, every other signature present and verified, and a
   * simulated lamport-delta cap that bounds what the treasury can actually be
   * debited regardless of instruction shape.
   */
  async function sponsorConfidentialAccountSetup({ txBase64, wallet }: { txBase64: string; wallet: string }): Promise<{
    signature: Signature;
    broadcast: boolean;
    rentLamports: string;
    transactionBase64?: string;
  }> {
    const tx = inspectTransaction(txBase64, { maxBytes: env.sponsor.maxTxBytes, maxInstructions: env.sponsor.maxInstructions });
    assertProgramsAllowed(tx, CONFIDENTIAL_SETUP_ALLOWLIST);
    assertOnlySponsorSignatureMissing(tx, deps.treasury.address);
    await assertPresentSignaturesValid(tx);
    assertConfidentialSetupShape(tx, deps.treasury.address);
    const worstCaseFee = assertComputeBudgetWithinPolicy(tx, {
      allowlist: CONFIDENTIAL_SETUP_ALLOWLIST,
      maxComputeUnits: env.sponsor.maxComputeUnits,
      maxCuPriceMicroLamports: env.sponsor.maxCuPriceMicroLamports,
      maxFeeLamports: env.sponsor.maxFeeLamports,
    });
    if (wallet === deps.treasury.address || !tx.accounts.some((a) => a.isSigner && a.address === wallet && a.address !== deps.treasury.address)) {
      throw new RejectedTransaction(`the session wallet ${wallet} is not a signer of this transaction`, "wallet-mismatch");
    }
    let reservation;
    try {
      reservation = setupLimiter.reserve(wallet, maxRentLamports + worstCaseFee);
    } catch (e) {
      if (e instanceof LimitError) throw new RejectedTransaction(e.message, "rate-limited");
      throw e;
    }
    try {
      return await cosignAndSend(tx, txBase64, worstCaseFee, reservation);
    } catch (e) {
      reservation.cancel();
      throw e;
    }
  }

  async function cosignAndSend(
    tx: InspectedTransaction,
    txBase64: string,
    worstCaseFee: bigint,
    reservation: { commit(n: bigint): void },
    bounds: { maxSpend: bigint; allowCredit: boolean; label: string } = { maxSpend: maxRentLamports, allowCredit: false, label: "setup" },
  ): Promise<{ signature: Signature; broadcast: boolean; rentLamports: string; transactionBase64?: string }> {
    const balanceBefore = (await deps.rpc.getBalance(deps.treasury.address, { commitment: "confirmed" }).send()).value;
    const simulation = await deps.rpc
      .simulateTransaction(txBase64 as Parameters<TreasuryRpc["simulateTransaction"]>[0], {
        encoding: "base64",
        commitment: "confirmed",
        sigVerify: false,
        replaceRecentBlockhash: false,
        accounts: { addresses: [deps.treasury.address], encoding: "base64" },
      })
      .send();
    if (simulation.value.err !== null) {
      throw new RejectedTransaction(`simulation failed: ${JSON.stringify(simulation.value.err)}`, "simulation-failed");
    }

    // Simulation does not charge the fee, so this delta is exactly what the
    // instructions themselves would take out of the treasury.
    const simulated = simulation.value.accounts?.[0];
    if (simulated == null) throw new RejectedTransaction("simulation did not return the treasury account state", "simulation-incomplete");
    // `balanceBefore` was read in a different round trip from the simulation, so they may describe
    // different bank states. The treasury is CREDITED in between on this route's own traffic (every
    // closing transaction returns rent), which made `spent` too small, or negative, and booked almost
    // nothing against the daily cap. The simulation reports only the post-state, so the pre-state is
    // bracketed by a read on each side and the larger one is used.
    //
    // The guarantee is for the MONOTONIC case only: if the balance moved in one direction between
    // the reads (credits only, the normal case here), the larger reading is at least the true
    // pre-state and `spent` cannot be under-counted. If it moved both ways (a debit then a credit),
    // the true pre-state can fall outside the bracket and the figure is a best estimate. That is
    // acceptable because the shape filter independently bounds what one transaction can take.
    const balanceAfter = (await deps.rpc.getBalance(deps.treasury.address, { commitment: "confirmed" }).send()).value;
    const reference = balanceBefore > balanceAfter ? balanceBefore : balanceAfter;
    const spent = reference - simulated.lamports;
    if (spent > bounds.maxSpend) {
      throw new RejectedTransaction(`transaction would debit the treasury ${spent} lamports, cap is ${bounds.maxSpend}`, "rent-too-high");
    }
    // A rent payment's last transaction closes the context states and so credits the treasury: that
    // is the rent coming back. A setup transaction has no reason to, so it is refused there.
    if (spent < 0n && !bounds.allowCredit) {
      throw new RejectedTransaction("transaction would increase the treasury balance; refusing to co-sign", "unexpected-credit");
    }

    const signed = await partiallySignTransaction([deps.treasury.keyPair], tx.transaction);
    assertIsFullySignedTransaction(signed);
    const signature = getSignatureFromTransaction(signed);
    const wire = getBase64EncodedWireTransaction(signed);
    const booked = (spent > 0n ? spent : 0n) + worstCaseFee;

    if (deps.mode === "mock") {
      reservation.commit(booked);
      log(`treasury: co-signed ${bounds.label} ${signature} (not broadcast: mock mode)`);
      // Deliberately NOT the signed wire. "Not broadcast" must mean "cannot land": a fully signed
      // transaction in the response lets any client submit it themselves, which turns mock mode into
      // a live path (and was the delivery mechanism for the context-authority theft in review F2).
      void wire;
      return { signature, broadcast: false, rentLamports: spent.toString() };
    }
    try {
      await deps.rpc.sendTransaction(wire, { encoding: "base64", skipPreflight: true, maxRetries: 3n }).send();
    } catch (e) {
      // A send that errors may still have propagated (skipPreflight, retries). Only a failure that
      // proves it did not land leaves the caller's budget and plan alone; any other is UNKNOWN, and
      // the spend stays booked until the window rolls.
      if (isKnownNotLanded(e)) throw e;
      reservation.commit(booked);
      throw new SendOutcomeUnknown(signature, e);
    }
    // Committed only once the send succeeded, so a definitely-failed send leaves the caller's budget alone.
    reservation.commit(booked);
    log(`treasury: sent ${bounds.label} ${signature}, net ${spent} lamports`);
    return { signature, broadcast: true, rentLamports: spent.toString() };
  }


  // --- confidential rent payment ----------------------------------------------------------------

  const rentLimits = deps.rentPaymentLimiter ?? createRateLimiter({
    maxPerWalletPerHour: env.rentPayment.maxPerWalletPerHour,
    maxGlobalPerHour: env.rentPayment.maxGlobalPerHour,
    maxLamportsPerWalletPerDay: env.rentPayment.maxLamportsPerWalletPerDay,
    maxLamportsGlobalPerDay: env.rentPayment.maxLamportsGlobalPerDay,
  });
  const rentPlans = createRentPlanRegistry();
  /** Message hashes already cosigned, for the length of a blockhash's life. */
  const seenMessages = new Map<string, number>();
  const REPLAY_WINDOW_MS = 5 * 60_000;

  /**
   * The rent-exempt minimum of the range-proof context, from the cluster. Not a constant: rent is a
   * network parameter, and this is the one figure a createAccount-without-a-proof is held to.
   * Cached briefly; a failed read is not cached.
   */
  let rangeRent: { at: number; lamports: bigint } | undefined;
  async function rangeContextRent(): Promise<bigint> {
    if (rangeRent !== undefined && Date.now() - rangeRent.at < 5 * 60_000) return rangeRent.lamports;
    const lamports = BigInt(await deps.rpc.getMinimumBalanceForRentExemption(RANGE_PROOF_CONTEXT_SPACE).send());
    rangeRent = { at: Date.now(), lamports };
    return lamports;
  }

  /**
   * Co-signs one transaction of a wallet's confidential rent payment, paying the fee AND the rent
   * of the proof context-state accounts from the treasury.
   *
   * The reason this is not `/api/sponsor`: the proof plan names the payer inside its instructions,
   * which the sponsor refuses outright. See `rentshape.ts` for exactly where the treasury is allowed
   * to appear (and everywhere it is not). On top of that shape: every other signature present and
   * valid, the session wallet must be a signer, a per-wallet and global limiter, a replay guard, and
   * a simulated cap on how far the treasury can be down.
   */
  async function sponsorRentPayment({ txBase64, wallet }: { txBase64: string; wallet: string }): Promise<{
    signature: Signature;
    broadcast: boolean;
    rentLamports: string;
    transactionBase64?: string;
  }> {
    const tx = inspectTransaction(txBase64, { maxBytes: env.sponsor.maxTxBytes, maxInstructions: env.sponsor.maxInstructions });
    assertProgramsAllowed(tx, RENT_PAYMENT_ALLOWLIST);
    assertOnlySponsorSignatureMissing(tx, deps.treasury.address);
    await assertPresentSignaturesValid(tx);
    if (wallet === deps.treasury.address) throw new RejectedTransaction("the treasury cannot be the session wallet", "wallet-mismatch");
    const walletSigns = tx.accounts.some((a) => a.isSigner && a.address === wallet);
    const walletToken = await associatedTokenAddress(wallet as Address, deps.mint);
    assertRentPaymentShape(tx, {
      treasury: deps.treasury.address,
      wallet,
      mint: deps.mint,
      walletToken,
      maxContextLamports: env.rentPayment.maxContextLamports,
      maxContextSpace: env.rentPayment.maxContextSpace,
      maxCreateAccounts: env.rentPayment.maxCreateAccounts,
      rangeContextLamports: await rangeContextRent(),
    });
    const use = contextUse(tx);
    if (!walletSigns || use.created.length > 0) {
      // A preparation transaction is not signed by the wallet, so the wallet has to be tied to it
      // some other way (rentplan.ts). First, the wallet must hold an rUSDC token account. That filters
      // an empty wallet, not a determined attacker: on devnet the account is nearly free. The same
      // applies to any transaction that creates a funded context, whoever signs it.
      const info = await deps.rpc.getAccountInfo(walletToken, { encoding: "base64", commitment: "confirmed" }).send();
      if (info.value === null) throw new RejectedTransaction(`the session wallet ${wallet} has no rUSDC account`, "wallet-mismatch");
    }
    const worstCaseFee = assertComputeBudgetWithinPolicy(tx, {
      allowlist: RENT_PAYMENT_ALLOWLIST,
      maxComputeUnits: env.sponsor.maxComputeUnits,
      maxCuPriceMicroLamports: env.sponsor.maxCuPriceMicroLamports,
      maxFeeLamports: env.sponsor.maxFeeLamports,
    });

    // Replay: the same signed message cosigned twice spends the limiter's budget twice for one
    // landing. Remembered for longer than a blockhash lives, so a replay can never land anyway.
    const key = createHash("sha256").update(new Uint8Array(tx.transaction.messageBytes)).digest("hex");
    const now = Date.now();
    for (const [k, at] of seenMessages) if (now - at > REPLAY_WINDOW_MS) seenMessages.delete(k);
    if (seenMessages.has(key)) throw new RejectedTransaction("this exact transaction was already co-signed", "replay");

    let reservation;
    try {
      reservation = rentLimits.reserve(wallet, env.rentPayment.maxSpendLamports + worstCaseFee);
    } catch (e) {
      if (e instanceof LimitError) throw new RejectedTransaction(e.message, "rate-limited");
      throw e;
    }
    // Context bookkeeping happens last and synchronously (no await between admit and the map write
    // beyond this point), so concurrent requests cannot both claim one context.
    let undoPlan: () => void;
    try {
      undoPlan = rentPlans.admit(wallet, use, walletSigns);
    } catch (e) {
      reservation.cancel();
      throw e;
    }
    seenMessages.set(key, now);
    try {
      return await cosignAndSend(tx, txBase64, worstCaseFee, reservation, {
        maxSpend: env.rentPayment.maxSpendLamports,
        allowCredit: true,
        label: "rent payment",
      });
    } catch (e) {
      // Unknown outcome: keep the replay entry, the booked spend and the plan; the TTL cleans up.
      if (e instanceof SendOutcomeUnknown) throw e;
      // Nothing landed, so a corrected retry of the same message is legitimate.
      seenMessages.delete(key);
      undoPlan();
      reservation.cancel();
      throw e;
    }
  }

  // --- rent dust --------------------------------------------------------------------------------

  // Sizes come from the program's IDL (layout.ts), never from constants here: Profile and Lease are
  // changing, and a hard-coded size would fund the wrong rent without any error.
  const dustGranted = new Set<string>();
  const dustLimiter = deps.rentDustLimiter ?? createRateLimiter({
    maxPerWalletPerHour: 1,
    maxGlobalPerHour: env.rentDust.maxGlobalPerHour,
    maxLamportsPerWalletPerDay: 1_000_000_000n,
    maxLamportsGlobalPerDay: env.rentDust.maxLamportsGlobalPerDay,
  });

  /** Just enough for a tenant's Application and Profile accounts: nothing for fees, which are the sponsor's. */
  async function rentDustAmount(): Promise<bigint> {
    const [application, profile] = await Promise.all([
      deps.rpc.getMinimumBalanceForRentExemption(BigInt((deps.accountLayout ?? accountLayout)("Application").size)).send(),
      deps.rpc.getMinimumBalanceForRentExemption(BigInt((deps.accountLayout ?? accountLayout)("Profile").size)).send(),
    ]);
    return BigInt(application) + BigInt(profile);
  }

  /**
   * Provisions the rent a wallet's `apply` and `fund_deposit` charge it (the program makes the
   * tenant the payer of its Application and Profile). The platform pays it invisibly: users never
   * hold or acquire SOL. Once per wallet, never to a wallet that already holds enough, and bounded
   * by a global daily cap.
   */
  async function grantRentDust({ wallet }: { wallet: string }): Promise<{ granted: boolean; lamports: string; signature?: Signature; reason?: string }> {
    if (wallet === deps.treasury.address) throw new RejectedTransaction("the treasury does not need rent dust", "wallet-is-treasury");
    if (dustGranted.has(wallet)) return { granted: false, lamports: "0", reason: "already-granted" };
    // Marked synchronously, before the first await: the checks below take network round trips, and
    // two concurrent requests for one wallet must not both get past the line above. Released on
    // every path that does not end in a grant.
    dustGranted.add(wallet);
    let reservation: ReturnType<typeof dustLimiter.reserve> | undefined;
    try {
      const amount = await rentDustAmount();
      const balance = (await deps.rpc.getBalance(wallet as Address, { commitment: "confirmed" }).send()).value;
      if (balance >= amount) {
        dustGranted.delete(wallet);
        return { granted: false, lamports: "0", reason: "already-funded" };
      }
      try {
        reservation = dustLimiter.reserve(wallet, amount);
      } catch (e) {
        if (e instanceof LimitError) throw new RejectedTransaction(e.message, "rate-limited");
        throw e;
      }
      const signatures = await deps.run(
        deps.treasury,
        sequentialInstructionPlan([getTransferSolInstruction({ source: deps.treasury, destination: wallet as Address, amount })]),
        `rent dust ${amount} lamports to ${wallet}`,
      );
      reservation.commit(amount);
      return { granted: true, lamports: amount.toString(), signature: signatures[0] };
    } catch (e) {
      dustGranted.delete(wallet);
      reservation?.cancel();
      throw e;
    }
  }

  return {
    mint: deps.mint,
    decimals: deps.decimals,
    treasuryAddress: deps.treasury.address,
    mode: deps.mode,
    supply,
    reserve,
    invariant,
    assertInvariant,
    creditReserve,
    releaseReserve,
    wrap,
    wrapAndMakeConfidential,
    unwrap,
    ensureAccount,
    sponsorConfidentialAccountSetup,
    sponsorRentPayment,
    grantRentDust,
    rentDustAmount,
    /** Append-only record of every reserve and wrap/unwrap movement this process saw. */
    ledger: () => ledger.slice(),
  };
}

export type Treasury = ReturnType<typeof createTreasury>;

/** Report with bigints stringified, for logs and JSON responses. */
export function reportForLog(report: InvariantReport) {
  return {
    supply: report.supply.toString(),
    reserve: report.reserve.toString(),
    headroom: report.headroom.toString(),
    ok: report.ok,
    reserveSource: report.reserveSource,
  };
}
