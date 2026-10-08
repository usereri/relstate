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
import {
  COMPUTE_BUDGET_PROGRAM,
  RejectedTransaction,
  assertOnlySponsorSignatureMissing,
  assertPresentSignaturesValid,
  assertProgramsAllowed,
  inspectTransaction,
} from "./txinspect.ts";

export type TreasuryRpc = Rpc<
  GetAccountInfoApi & GetBalanceApi & GetMinimumBalanceForRentExemptionApi & GetTokenAccountBalanceApi & SimulateTransactionApi & SendTransactionApi
>;

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
  /** Mock-mode stand-in for the real USDC reserve. */
  let mockReserve = 0n;
  const ledger: Array<{ at: number; kind: "credit" | "debit" | "wrap" | "unwrap"; amount: bigint; ref: string }> = [];

  async function supply(): Promise<bigint> {
    return (await fetchMint(deps.rpc, deps.mint)).data.supply;
  }

  async function reserve(): Promise<bigint> {
    if (deps.mode === "mock") return mockReserve;
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
  async function sponsorConfidentialAccountSetup({ txBase64 }: { txBase64: string }): Promise<{
    signature: Signature;
    broadcast: boolean;
    rentLamports: string;
    transactionBase64?: string;
  }> {
    const tx = inspectTransaction(txBase64, { maxBytes: env.sponsor.maxTxBytes, maxInstructions: env.sponsor.maxInstructions });
    assertProgramsAllowed(tx, CONFIDENTIAL_SETUP_ALLOWLIST);
    assertOnlySponsorSignatureMissing(tx, deps.treasury.address);
    await assertPresentSignaturesValid(tx);

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
    const spent = balanceBefore - simulated.lamports;
    if (spent > maxRentLamports) {
      throw new RejectedTransaction(`transaction would debit the treasury ${spent} lamports, cap is ${maxRentLamports}`, "rent-too-high");
    }
    if (spent < 0n) throw new RejectedTransaction("transaction would increase the treasury balance; refusing to co-sign", "unexpected-credit");

    const signed = await partiallySignTransaction([deps.treasury.keyPair], tx.transaction);
    assertIsFullySignedTransaction(signed);
    const signature = getSignatureFromTransaction(signed);
    const wire = getBase64EncodedWireTransaction(signed);

    if (deps.mode === "mock") {
      log(`treasury: co-signed setup ${signature} (not broadcast: mock mode)`);
      return { signature, broadcast: false, rentLamports: spent.toString(), transactionBase64: wire };
    }
    await deps.rpc.sendTransaction(wire, { encoding: "base64", skipPreflight: true, maxRetries: 3n }).send();
    log(`treasury: sent setup ${signature}, rent ${spent} lamports`);
    return { signature, broadcast: true, rentLamports: spent.toString() };
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
