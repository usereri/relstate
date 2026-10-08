// rUSDC mint creation, per the design table in the demo-day plan. Lives in the
// backend (not in scripts/) so tests can create a throwaway mint with exactly
// the same settings the demo mint has — a test against a differently-configured
// mint would prove nothing.
import { getTransferSolInstruction } from "@solana-program/system";
import { getCreateMintInstructionPlan } from "@solana-program/token-2022";
import {
  generateKeyPairSigner,
  sequentialInstructionPlan,
  type Address,
  type KeyPairSigner,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import type { RunPlan } from "./confidential.ts";
import type { SolanaClient } from "./rpc.ts";

export const RUSDC_DECIMALS = 6;

export type CreateRusdcMintResult = {
  mint: Address;
  signatures: Signature[];
};

/**
 * Token-2022, 6 decimals (so 1 USDC = 1_000_000 base units = 1 rUSDC), with:
 *
 * - `ConfidentialTransferMint` and **auto-approve on**, so a new tenant's
 *   confidential account works on first use with no operator step;
 * - the **auditor ElGamal pubkey set at creation**, which is what makes every
 *   transfer decryptable by us for compliance (`docs/privacy.md`). It cannot be
 *   added retroactively to transfers already made, so it has to be set here;
 * - **mint and freeze authority both on the treasury key**: minting happens only
 *   against a confirmed on-ramp deposit, and freeze is the compliance
 *   kill-switch (not exercised in the demo).
 */
export async function createRusdcMint(options: {
  client: SolanaClient;
  run: RunPlan;
  treasury: TransactionSigner;
  /** Base58 ElGamal public key of the auditor. */
  auditorElgamalPubkey: Address;
  decimals?: number;
  mintSigner?: KeyPairSigner;
}): Promise<CreateRusdcMintResult> {
  const mint = options.mintSigner ?? (await generateKeyPairSigner());
  const signatures = await options.run(
    options.treasury,
    await getCreateMintInstructionPlan(
      { getMinimumBalance: async (size: number) => options.client.rpc.getMinimumBalanceForRentExemption(BigInt(size)).send() },
      {
        payer: options.treasury,
        newMint: mint,
        decimals: options.decimals ?? RUSDC_DECIMALS,
        mintAuthority: options.treasury,
        freezeAuthority: options.treasury.address,
        extensions: [
          {
            __kind: "ConfidentialTransferMint",
            authority: options.treasury.address,
            autoApproveNewAccounts: true,
            auditorElgamalPubkey: options.auditorElgamalPubkey,
          },
        ],
      },
    ),
    `create rUSDC mint ${mint.address} (Token-2022, ${options.decimals ?? RUSDC_DECIMALS} decimals, confidential transfers, auditor set)`,
  );
  return { mint: mint.address, signatures };
}

/**
 * Moves SOL between two keys we hold. Used to top up a throwaway devnet key,
 * because the public faucet is rate-limited and cannot be relied on mid-run.
 */
export async function fundAccount(options: {
  run: RunPlan;
  funder: TransactionSigner;
  destination: Address;
  lamports: bigint;
}): Promise<Signature[]> {
  return options.run(
    options.funder,
    sequentialInstructionPlan([
      getTransferSolInstruction({ source: options.funder, destination: options.destination, amount: options.lamports }),
    ]),
    `fund ${options.destination} with ${options.lamports} lamports`,
  );
}

/** Re-exported so `scripts/` can build signers without resolving kit from its own directory. */
export { generateKeyPairSigner };
