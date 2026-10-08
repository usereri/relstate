// Contract 2: POST /api/sponsor.
//
// The order of operations is the security property, not an implementation
// detail. Nothing is signed until every static check has passed AND the
// transaction has simulated successfully, and the spend is reserved against the
// caps before signing so a burst cannot slip past them.
//
//   1. session token      — the call is attributable to one wallet
//   2. size + instruction count
//   3. no address lookup tables
//   4. program allowlist
//   5. fee payer appears only as the message fee payer (never in an instruction)
//   6. every other required signature is present and cryptographically valid
//   7. compute-unit and priority-fee caps, worst-case fee bound
//   8. reserve the worst-case fee against per-wallet and global caps
//   9. simulate against the client's own blockhash
//  10. co-sign and broadcast
import {
  assertIsFullySignedTransaction,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  partiallySignTransaction,
  type KeyPairSigner,
  type Rpc,
  type SendTransactionApi,
  type SimulateTransactionApi,
} from "@solana/kit";
import { env } from "./env.ts";
import { LimitError, type RateLimiter } from "./limits.ts";
import {
  RejectedTransaction,
  assertComputeBudgetWithinPolicy,
  assertOnlySponsorSignatureMissing,
  assertPresentSignaturesValid,
  assertProgramsAllowed,
  assertSponsorNotUsedByInstructions,
  inspectTransaction,
  readComputeBudget,
  type SponsorPolicy,
} from "./txinspect.ts";

export type SponsorRpc = Pick<Rpc<SimulateTransactionApi & SendTransactionApi>, "simulateTransaction" | "sendTransaction">;

export type SponsorPolicyFull = SponsorPolicy & { maxTxBytes: number; maxInstructions: number };

export const defaultSponsorPolicy = (allowlist: readonly string[]): SponsorPolicyFull => ({
  allowlist,
  maxTxBytes: env.sponsor.maxTxBytes,
  maxInstructions: env.sponsor.maxInstructions,
  maxComputeUnits: env.sponsor.maxComputeUnits,
  maxCuPriceMicroLamports: env.sponsor.maxCuPriceMicroLamports,
  maxFeeLamports: env.sponsor.maxFeeLamports,
});

export type SponsorDeps = {
  rpc: SponsorRpc;
  feePayer: KeyPairSigner;
  limiter: RateLimiter;
  policy: SponsorPolicyFull;
  /**
   * False co-signs and returns the transaction without broadcasting. That is
   * the mock-mode default, where the fee payer is an ephemeral key with no
   * lamports: every check and the simulation still run, so the endpoint is
   * exercisable with no secrets, but nothing is sent.
   */
  broadcast: boolean;
  /**
   * Simulation is mandatory whenever a real fee payer key is configured, and is
   * the last gate before signing.
   *
   * It is skipped only for an ephemeral mock key: that key has never existed
   * on-chain, so every simulation returns `AccountNotFound` for the fee payer
   * and the endpoint could never succeed — which would make the mock backend
   * useless to the app lane. Nothing is broadcast in that mode either, so a
   * transaction that would have failed costs nothing.
   */
  simulate: boolean;
  now?: () => number;
  log?: (...args: unknown[]) => void;
};

export type SponsorResult = {
  signature: string;
  broadcast: boolean;
  feeLamports: string;
  unitsConsumed: string | undefined;
  /** Present when `broadcast` is false, so the caller can inspect or send it themselves. */
  transactionBase64?: string;
};

export function createSponsorService(deps: SponsorDeps) {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});

  async function sponsor({ txBase64, wallet }: { txBase64: string; wallet: string }): Promise<SponsorResult> {
    const tx = inspectTransaction(txBase64, {
      maxBytes: deps.policy.maxTxBytes,
      maxInstructions: deps.policy.maxInstructions,
    });

    assertProgramsAllowed(tx, deps.policy.allowlist);
    assertSponsorNotUsedByInstructions(tx, deps.feePayer.address);
    assertOnlySponsorSignatureMissing(tx, deps.feePayer.address);
    await assertPresentSignaturesValid(tx);
    const worstCaseFee = assertComputeBudgetWithinPolicy(tx, deps.policy);

    // The session wallet must be a signer of the transaction, so the spend is
    // attributable and one wallet's session cannot spend another's budget.
    //
    // The fee payer is excluded explicitly. It is always a signer at index 0, so
    // without this a session issued for the sponsor's own address — which
    // /health and GET /api/sponsor publish — would satisfy the check, and a
    // transaction no user ever signed would be sponsored. That is the only way
    // the wallet check could be satisfied without a user signature.
    if (wallet === deps.feePayer.address) {
      throw new RejectedTransaction("a session for the fee payer's own address cannot sponsor transactions", "wallet-is-sponsor");
    }
    const signsItself = tx.accounts.some((a) => a.isSigner && a.address === wallet && a.address !== deps.feePayer.address);
    if (!signsItself) {
      throw new RejectedTransaction(`the session wallet ${wallet} is not a signer of this transaction`, "wallet-mismatch");
    }

    const reservation = deps.limiter.reserve(wallet, worstCaseFee, now());
    try {
      let unitsConsumed: bigint | undefined;
      if (deps.simulate) {
        const simulation = await deps.rpc
          .simulateTransaction(txBase64 as Parameters<SponsorRpc["simulateTransaction"]>[0], {
            encoding: "base64",
            commitment: "confirmed",
            // We have not signed yet, so signatures cannot verify; and we keep the
            // client's blockhash so an expired one fails here rather than after we pay.
            sigVerify: false,
            replaceRecentBlockhash: false,
          })
          .send();

        if (simulation.value.err !== null) {
          throw new RejectedTransaction(
            `simulation failed: ${JSON.stringify(simulation.value.err)}${
              simulation.value.logs ? ` — ${simulation.value.logs.slice(-3).join(" | ")}` : ""
            }`,
            "simulation-failed",
          );
        }
        unitsConsumed = simulation.value.unitsConsumed;
        if (unitsConsumed !== undefined && unitsConsumed > BigInt(deps.policy.maxComputeUnits)) {
          throw new RejectedTransaction(
            `simulation consumed ${unitsConsumed} compute units, cap is ${deps.policy.maxComputeUnits}`,
            "compute-limit",
          );
        }
      }

      const signed = await partiallySignTransaction([deps.feePayer.keyPair], tx.transaction);
      assertIsFullySignedTransaction(signed);
      const signature = getSignatureFromTransaction(signed);
      const wire = getBase64EncodedWireTransaction(signed);

      if (!deps.broadcast) {
        log(`sponsor: co-signed ${signature} for ${wallet} (not broadcast: mock mode)`);
        reservation.commit(worstCaseFee);
        return {
          signature,
          broadcast: false,
          feeLamports: worstCaseFee.toString(),
          unitsConsumed: unitsConsumed?.toString(),
          transactionBase64: wire,
        };
      }

      await deps.rpc
        .sendTransaction(wire, {
          encoding: "base64",
          // Already simulated above; preflight would only repeat it.
          skipPreflight: true,
          maxRetries: 3n,
        })
        .send();
      log(`sponsor: sent ${signature} for ${wallet} (${worstCaseFee} lamports worst case)`);
      reservation.commit(worstCaseFee);
      return {
        signature,
        broadcast: true,
        feeLamports: worstCaseFee.toString(),
        unitsConsumed: unitsConsumed?.toString(),
      };
    } catch (error) {
      // Nothing was spent, so the reservation must not count against the caps.
      reservation.cancel();
      throw error;
    }
  }

  return { sponsor, policy: deps.policy, feePayer: deps.feePayer.address, broadcast: deps.broadcast, readComputeBudget };
}

export type SponsorService = ReturnType<typeof createSponsorService>;
export { LimitError, RejectedTransaction };
