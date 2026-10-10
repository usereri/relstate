// What a treasury-cosigned rent-payment transaction may contain.
//
// `/api/sponsor` refuses any transaction that names the fee payer inside an instruction, and that
// rule stays absolute. A confidential transfer cannot satisfy it: the proof plan funds its
// context-state accounts from the payer, so the payer is inside `createAccount`, inside every
// proof-verify instruction (as the context-state authority) and inside every close (as the lamport
// destination and authority). Measured on devnet, all 5 transactions of a real rent payment do.
//
// So this route uses the TREASURY key instead, the same trade `treasury.sponsorConfidentialAccountSetup`
// makes, under a filter that is as tight as the plan allows. The shape below is what the plan
// actually produces (scripts/exit-gate.ts --probe, 2026-10-10):
//
//   tx 1  System createAccount(treasury -> ctx A)      ZK verify (ctx A, authority treasury)
//   tx 2  System createAccount(treasury -> ctx B)      ZK verify (ctx B, authority treasury)
//   tx 3  System createAccount(treasury -> ctx C)
//   tx 4                                               ZK verify range proof (ctx C, authority treasury)
//   tx 5  Token-2022 ConfidentialTransfer   relstate pay_rent   ZK close x3 (dest + authority treasury)
//
// The treasury is confined to the positions where it is harmless:
//
//   - System `createAccount`, as the funder, into an account owned by the ZK proof program, with a
//     lamport and size cap. No other System instruction exists in this route, so no transfer.
//   - ZK proof program, as the context-state AUTHORITY, which is REQUIRED (account 1 of every proof
//     instruction, exactly two accounts). The authority is recorded when the proof is verified and
//     decides who may close the context state later. It is not a signer there, so the client picks
//     it freely unless the filter insists: a proof that named the CLIENT as authority would let them
//     close an account we funded straight to themselves, outside any route. Requiring it is what
//     keeps closes ours.
//   - ZK `CloseContextState`, as lamport destination and authority, so the rent comes back to us.
//     A close that named anyone else as destination would let a client spend OUR authority to move
//     OUR rent, so the destination is pinned.
//
// And it can never be anywhere else: not in a Token-2022 instruction (so never an authority over a
// token account or the mint), not in `pay_rent`, not at account 0 of a ZK instruction (the account
// being written or closed). The wallet being paid for must be the confidential transfer's authority
// and the owner of its source account, and the mint must be rUSDC.
//
// RESIDUAL, stated plainly because an earlier version of this comment claimed the opposite: this is
// bounded theft, not "nobody can move that rent". The plan itself puts a createAccount in a
// transaction with NO verify (tx 3: the range-proof context is too large to create and verify in
// one transaction), so a client can have the treasury fund a ZK-owned context and then, in their own
// transaction outside any route, verify a proof into it naming THEMSELVES as authority and close it
// to themselves. Requiring the treasury as authority closes the other route to the same end (a
// verify inside a cosigned transaction); nothing in a filter can close this one.
//
// What the filter does is make it as small as the plan allows: one createAccount per transaction, a
// createAccount with no proof beside it must be exactly the range context at exactly its rent
// (2_159_000 lamports on devnet today, about 0.0022 SOL), and every other context must be verified
// in the same transaction with the treasury as authority. So the loss per cosigned transaction is
// that one rent, and the limiter caps how many such transactions a wallet (30M lamports, about 13)
// and the whole backend (100M, about 46) may have per day: roughly 0.03 SOL per wallet per day and
// 0.1 SOL globally per day. Per-wallet caps only mean something if a wallet costs something to make,
// which is what real identity (KYC) is for; with mock auth one attacker can rotate wallets to the
// global cap. The fix is post-demo: a treasury-owned pool of pre-created contexts, so no separate
// create is ever needed.
import { createHash } from "node:crypto";
import { getAddressDecoder, type Address } from "@solana/kit";
import { RELSTATE_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, ZK_ELGAMAL_PROOF_PROGRAM } from "./contracts.ts";
import { COMPUTE_BUDGET_PROGRAM, RejectedTransaction, type InspectedInstruction, type InspectedTransaction } from "./txinspect.ts";

export const RENT_PAYMENT_ALLOWLIST = [SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, ZK_ELGAMAL_PROOF_PROGRAM, RELSTATE_PROGRAM, COMPUTE_BUDGET_PROGRAM] as const;

/** Anchor's instruction discriminator: the first 8 bytes of sha256("global:pay_rent"). */
export const PAY_RENT_DISCRIMINATOR = new Uint8Array(createHash("sha256").update("global:pay_rent").digest().subarray(0, 8));

const SYSTEM_CREATE_ACCOUNT = 0;
const CREATE_ACCOUNT_DATA_LENGTH = 4 + 8 + 8 + 32;
/** Token-2022: `ConfidentialTransferExtension`, then `Transfer`. */
const CT_EXTENSION = 27;
const CT_TRANSFER = 7;
/** ZK ElGamal proof program: tag 0 closes a context state, tags 1..12 verify a proof. */
const ZK_CLOSE = 0;
const ZK_MAX_VERIFY_TAG = 12;
const MAX_TRANSFER_DATA = 512;

/**
 * The range-proof context state: `ProofContextState` header (authority 32 + proof type 1) plus the
 * batched u128 range-proof context (264). Measured from a real plan on devnet (scripts/exit-gate.ts
 * --probe, 2026-10-10: space 297, rent 2_159_000), where it is the one context created in a
 * transaction of its own, because the proof that fills it is too large to share one with it.
 */
export const RANGE_PROOF_CONTEXT_SPACE = 297n;

export type RentPaymentRules = {
  treasury: string;
  /** The session wallet: the tenant, who signs the transfer and `pay_rent`. */
  wallet: string;
  /** The rUSDC mint, and the wallet's token account on it. */
  mint: string;
  walletToken: string;
  maxContextLamports: bigint;
  maxContextSpace: bigint;
  maxCreateAccounts: number;
  /**
   * What a createAccount that is NOT verified in the same transaction must fund: exactly the range
   * context's rent-exempt minimum at this moment (the caller reads it from the cluster; rent is not
   * a constant). Anything else created alone is refused, so the one shape the plan forces on us is
   * also the only one a client can use to leave an uninitialised account behind.
   */
  rangeContextLamports: bigint;
};

const deny = (index: number, why: string, code = "instruction-not-allowed"): never => {
  throw new RejectedTransaction(`instruction ${index}: ${why}`, code);
};

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function isTransfer(ix: InspectedInstruction): boolean {
  return ix.programAddress === TOKEN_2022_PROGRAM && ix.data[0] === CT_EXTENSION && ix.data[1] === CT_TRANSFER;
}

export function assertRentPaymentShape(tx: InspectedTransaction, rules: RentPaymentRules): void {
  const decodeAddress = getAddressDecoder();
  let creates = 0;
  let transfers = 0;
  let payRents = 0;

  for (const ix of tx.instructions) {
    const at = (position: number): Address | undefined => ix.accounts[position]?.address;
    const treasuryAt = ix.accounts.flatMap((a, position) => (a.address === rules.treasury ? [position] : []));

    switch (ix.programAddress) {
      case SYSTEM_PROGRAM: {
        // The only System instruction in this route is createAccount. A transfer, assign, allocate
        // or create-with-seed would each let a signed treasury do something other than fund a proof.
        if (ix.data.length !== CREATE_ACCOUNT_DATA_LENGTH) deny(ix.index, "only System createAccount is permitted");
        const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
        if (view.getUint32(0, true) !== SYSTEM_CREATE_ACCOUNT) deny(ix.index, "only System createAccount is permitted");
        if (ix.accounts.length !== 2 || at(0) !== rules.treasury || at(1) === rules.treasury) {
          deny(ix.index, "createAccount must be funded by the treasury into a different account");
        }
        const lamports = view.getBigUint64(4, true);
        const space = view.getBigUint64(12, true);
        const owner = decodeAddress.decode(ix.data.subarray(20, 52));
        if (owner !== ZK_ELGAMAL_PROOF_PROGRAM) deny(ix.index, `the new account must be owned by the ZK proof program, not ${owner}`);
        if (lamports > rules.maxContextLamports) deny(ix.index, `createAccount funds ${lamports} lamports, cap is ${rules.maxContextLamports}`, "context-too-expensive");
        if (space === 0n || space > rules.maxContextSpace) deny(ix.index, `createAccount allocates ${space} bytes, allowed 1..${rules.maxContextSpace}`, "context-too-large");
        if (++creates > rules.maxCreateAccounts) deny(ix.index, `more than ${rules.maxCreateAccounts} createAccount instructions`, "too-many-accounts");
        // Either the SAME transaction verifies a proof into the new account, which (because the
        // verify must name the treasury as its authority, below) leaves nothing a client can later
        // claim; or this is the range-proof context in a transaction of its own, and then it must be
        // exactly that and nothing bigger or cheaper. See the RESIDUAL note in the header.
        const created = at(1);
        const initialisedHere = tx.instructions.some(
          (other) => other.index > ix.index && other.programAddress === ZK_ELGAMAL_PROOF_PROGRAM && other.data[0] !== ZK_CLOSE && other.accounts[0]?.address === created,
        );
        if (!initialisedHere && (space !== RANGE_PROOF_CONTEXT_SPACE || lamports !== rules.rangeContextLamports)) {
          deny(
            ix.index,
            `a context created without a proof in the same transaction must be exactly the range-proof context (${RANGE_PROOF_CONTEXT_SPACE} bytes, ${rules.rangeContextLamports} lamports), not ${space} bytes and ${lamports} lamports`,
            "unverified-context",
          );
        }
        break;
      }

      case ZK_ELGAMAL_PROOF_PROGRAM: {
        const tag = ix.data[0];
        if (tag === undefined || tag > ZK_MAX_VERIFY_TAG) deny(ix.index, `ZK proof instruction tag ${tag} is not permitted`);
        // Account 0 is the context state being written or closed. It must never be ours.
        if (treasuryAt.includes(0)) deny(ix.index, "the treasury cannot be the context-state account");
        if (tag === ZK_CLOSE) {
          // [context state, lamport destination, authority]. Both of ours: only we sign a close, and
          // the rent must come back to us, never to a destination the client chose.
          if (ix.accounts.length !== 3 || at(1) !== rules.treasury || at(2) !== rules.treasury) {
            deny(ix.index, "CloseContextState must return the rent to the treasury, under the treasury's authority", "close-destination");
          }
        } else {
          // The authority is not a signer at verify time: it is merely RECORDED in the context state,
          // and later decides who may close it. So the client chooses it freely unless we insist, and
          // an attacker-chosen authority could close an account WE funded straight to themselves,
          // outside any route. Rejecting the treasury elsewhere is not enough; it has to be required
          // here. Exactly two accounts: [context state, authority]. A proof with no context account
          // is not something the plan produces and would need no rent, so it has no business here.
          if (ix.accounts.length !== 2 || at(1) !== rules.treasury) {
            deny(ix.index, "a proof instruction must record the treasury as its context-state authority", "wrong-context-authority");
          }
        }
        break;
      }

      case TOKEN_2022_PROGRAM: {
        // Never an authority over a token account or the mint: the treasury is the mint and freeze
        // authority, so any Token-2022 instruction naming it could mint, freeze or burn.
        if (!isTransfer(ix)) deny(ix.index, `Token-2022 instruction ${ix.data[0]},${ix.data[1]} is not permitted; only ConfidentialTransfer is`);
        if (treasuryAt.length > 0) deny(ix.index, "the treasury cannot appear in a Token-2022 instruction", "treasury-in-token-instruction");
        if (ix.data.length > MAX_TRANSFER_DATA) deny(ix.index, `ConfidentialTransfer data is ${ix.data.length} bytes, cap is ${MAX_TRANSFER_DATA}`);
        const authority = ix.accounts[ix.accounts.length - 1];
        if (at(0) !== rules.walletToken) deny(ix.index, "the transfer must come from the paying wallet's own rUSDC account", "wrong-source");
        if (at(1) !== rules.mint) deny(ix.index, "the transfer must be on the rUSDC mint", "wrong-mint");
        if (authority === undefined || authority.address !== rules.wallet || !authority.isSigner) {
          deny(ix.index, "the paying wallet must be the transfer's signing authority", "wrong-authority");
        }
        if (++transfers > 1) deny(ix.index, "more than one confidential transfer in a transaction");
        break;
      }

      case RELSTATE_PROGRAM: {
        if (!same(ix.data, PAY_RENT_DISCRIMINATOR)) deny(ix.index, "only pay_rent may be called on the relstate program");
        if (treasuryAt.length > 0) deny(ix.index, "the treasury cannot appear in a relstate instruction", "treasury-in-program-instruction");
        const tenant = ix.accounts[0];
        if (tenant === undefined || tenant.address !== rules.wallet || !tenant.isSigner) deny(ix.index, "the paying wallet must be pay_rent's tenant", "wrong-authority");
        if (at(2) !== rules.mint || at(3) !== rules.walletToken) deny(ix.index, "pay_rent must name the rUSDC mint and the wallet's own account", "wrong-mint");
        // The program insists on this too; checking it here keeps the route from being a general
        // pay_rent relay, and stops a pay_rent that would fail from costing a cosignature.
        const before = tx.instructions[ix.index - 1];
        if (before === undefined || !isTransfer(before)) deny(ix.index, "pay_rent must directly follow the confidential transfer", "missing-transfer");
        if (++payRents > 1) deny(ix.index, "more than one pay_rent in a transaction");
        break;
      }

      case COMPUTE_BUDGET_PROGRAM:
        break; // bounded separately by assertComputeBudgetWithinPolicy

      default:
        deny(ix.index, `program ${ix.programAddress} is not permitted`, "program-not-allowed");
    }
  }
}
