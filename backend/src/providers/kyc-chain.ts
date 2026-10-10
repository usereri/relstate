// The chain half of KYC: build `attest` and `revoke` for the relstate program, and read the
// accounts back (docs/contracts/attestation.md).
//
// Hand-rolled over @solana/kit rather than going through Anchor's TypeScript client, for the same
// reason treasury.ts hand-rolls its Token-2022 calls: the backend is a kit codebase with no
// web3.js and no Anchor dependency, and pulling one in for two instructions would double its
// dependency tree. The two things that must match the program exactly are asserted in tests
// against the generated IDL, so a program change that moves an account or renames an instruction
// fails here rather than on stage:
//
//   * the 8-byte instruction discriminator, `sha256("global:<name>")[0..8]`;
//   * the account order, which is the order the fields are declared in the `#[derive(Accounts)]`
//     struct — names do nothing on the wire.
//
// The one security-relevant detail: `attest` takes the fee payer and the issuer as *two separate
// signers*. The payer funds the account's rent; only the issuer's signature makes the attestation
// real (see the module comment in programs/relstate/src/instructions/attest.rs).
import { createHash } from "node:crypto";
import {
  AccountRole,
  fetchEncodedAccount,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU32Decoder,
  singleInstructionPlan,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type GetAccountInfoApi,
  type Instruction,
  type InstructionWithSigners,
  type Rpc,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import { RELSTATE_PROGRAM, SYSTEM_PROGRAM } from "../contracts.ts";
import type { RunPlan } from "../confidential.ts";

const PROGRAM = RELSTATE_PROGRAM as Address;
const SYSTEM = SYSTEM_PROGRAM as Address;

const addresses = getAddressEncoder();
const addressDecoder = getAddressDecoder();
const u32 = getU32Decoder();

const prefix = (text: string): Uint8Array => new Uint8Array(createHash("sha256").update(text).digest().subarray(0, 8));

/** Anchor's instruction prefix: the first 8 bytes of `sha256("global:<snake_case_name>")`. */
export const instructionDiscriminator = (name: string): Uint8Array => prefix(`global:${name}`);

/** Anchor's account prefix: the first 8 bytes of `sha256("account:<TypeName>")`. */
export const accountDiscriminator = (name: string): Uint8Array => prefix(`account:${name}`);

const ATTEST = instructionDiscriminator("attest");
const REVOKE = instructionDiscriminator("revoke");
const ATTESTATION_ACCOUNT = accountDiscriminator("Attestation");
const CONFIG_ACCOUNT = accountDiscriminator("Config");

const seeds = (...parts: (string | Uint8Array)[]) => parts.map((p) => (typeof p === "string" ? new TextEncoder().encode(p) : p));

/** An account list that may carry signers, which is what `signTransactionMessageWithSigners` reads. */
type Accounts = readonly (AccountMeta | AccountSignerMeta)[];

export const configPda = async (): Promise<Address> => {
  const [pda] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: seeds("config") });
  return pda;
};

export const attestationPda = async (wallet: Address): Promise<Address> => {
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAM,
    seeds: seeds("attestation", new Uint8Array(addresses.encode(wallet))),
  });
  return pda;
};

export type AttestationAccount = {
  wallet: Address;
  issuer: Address;
  level: number;
  verifiedAt: number;
  expiresAt: number;
  revoked: boolean;
  /** Hex, lower case. `sha256(applicantId || salt)`; no personal data. */
  subjectHash: string;
};

/** What the gate in `apply` / `propose_lease` reads out of the config. */
export type KycPolicy = {
  /** All-zero when no issuer has been set, in which case nothing can be attested. */
  issuer: Address;
  requireKyc: boolean;
};

export const NO_ISSUER = "11111111111111111111111111111111" as Address;

const sameDiscriminator = (data: Uint8Array, expected: Uint8Array): boolean =>
  data.length >= 8 && expected.every((b, i) => data[i] === b);

/**
 * Decodes an `Attestation` account, or null when the bytes are not one.
 *
 * Checked rather than assumed: an account at the right address with the wrong discriminator is
 * either another program's or a different version of ours, and reading it as an attestation would
 * invent a verified identity out of unrelated bytes.
 */
export function decodeAttestation(data: Uint8Array): AttestationAccount | null {
  if (!sameDiscriminator(data, ATTESTATION_ACCOUNT)) return null;
  // 8 discriminator + 32 wallet + 32 issuer + 1 level + 8 verified_at + 8 expires_at + 1 revoked
  // + 32 subject_hash + 1 bump
  if (data.length < 123) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    wallet: addressDecoder.decode(data.subarray(8, 40)),
    issuer: addressDecoder.decode(data.subarray(40, 72)),
    level: data[72]!,
    verifiedAt: Number(view.getBigInt64(73, true)),
    expiresAt: Number(view.getBigInt64(81, true)),
    revoked: data[89] === 1,
    subjectHash: Buffer.from(data.subarray(90, 122)).toString("hex"),
  };
}

/**
 * Decodes the KYC half of the `Config` account.
 *
 * `issuer` and `require_kyc` sit *after* the `mints` vector, so their offset depends on how many
 * mints are allowed — and a config account created before workstream D landed has neither field
 * written. A buffer that stops short of them therefore reads as "no issuer, gate off", which is
 * exactly how the program reads the same bytes (see `SetKycConfig`'s realloc).
 */
export function decodeKycPolicy(data: Uint8Array): KycPolicy | null {
  if (!sameDiscriminator(data, CONFIG_ACCOUNT)) return null;
  const mintsAt = 8 + 32 + 1;
  if (data.length < mintsAt + 4) return null;
  const mintCount = u32.decode(data.subarray(mintsAt, mintsAt + 4));
  const issuerAt = mintsAt + 4 + mintCount * 32;
  if (data.length < issuerAt + 33) return { issuer: NO_ISSUER, requireKyc: false };
  return {
    issuer: addressDecoder.decode(data.subarray(issuerAt, issuerAt + 32)),
    requireKyc: data[issuerAt + 32] === 1,
  };
}

export type AttestationChainRpc = Rpc<GetAccountInfoApi>;

export async function fetchAttestation(rpc: AttestationChainRpc, wallet: Address): Promise<AttestationAccount | null> {
  const account = await fetchEncodedAccount(rpc, await attestationPda(wallet));
  return account.exists ? decodeAttestation(account.data as Uint8Array) : null;
}

export async function fetchKycPolicy(rpc: AttestationChainRpc): Promise<KycPolicy | null> {
  const account = await fetchEncodedAccount(rpc, await configPda());
  return account.exists ? decodeKycPolicy(account.data as Uint8Array) : null;
}

/** Mirrors `Attestation::is_valid` in the program, so the backend and the chain agree on "verified". */
export function isValid(attestation: AttestationAccount | null, policy: KycPolicy | null, now: number, wallet: Address): boolean {
  if (attestation === null) return false;
  // The PDA seeds already bind the account to a wallet; compared anyway, as state.rs does.
  if (attestation.wallet !== wallet) return false;
  // No readable Config means no known issuer to compare against, so nothing can be vouched for.
  if (policy === null || attestation.issuer !== policy.issuer) return false;
  return attestation.level >= 1 && !attestation.revoked && (attestation.expiresAt === 0 || attestation.expiresAt > now);
}

export type AttestInput = {
  payer: TransactionSigner;
  issuer: TransactionSigner;
  wallet: Address;
  /** 1 basic, 2 enhanced. The program refuses anything else. */
  level: number;
  /** Unix seconds, or 0 for never. */
  expiresAt: number;
  /** 32 bytes: `sha256(applicantId || salt)`. */
  subjectHash: Uint8Array;
};

/**
 * `attest(level, expires_at, subject_hash)`.
 *
 * Account order is the program's declaration order: payer, config, issuer, wallet, attestation,
 * system program.
 */
export async function getAttestInstruction(input: AttestInput): Promise<Instruction & InstructionWithSigners> {
  if (input.subjectHash.length !== 32) throw new Error(`subject hash must be 32 bytes, got ${input.subjectHash.length}`);
  if (!Number.isInteger(input.level) || input.level < 1 || input.level > 2) throw new Error(`attestation level must be 1 or 2, got ${input.level}`);
  if (!Number.isInteger(input.expiresAt) || input.expiresAt < 0) throw new Error(`attestation expiry must be a non-negative unix timestamp, got ${input.expiresAt}`);

  const data = new Uint8Array(8 + 1 + 8 + 32);
  data.set(ATTEST, 0);
  data[8] = input.level;
  new DataView(data.buffer).setBigInt64(9, BigInt(input.expiresAt), true);
  data.set(input.subjectHash, 17);

  const accounts: Accounts = [
    { address: input.payer.address, role: AccountRole.WRITABLE_SIGNER, signer: input.payer },
    { address: await configPda(), role: AccountRole.READONLY },
    { address: input.issuer.address, role: AccountRole.READONLY_SIGNER, signer: input.issuer },
    { address: input.wallet, role: AccountRole.READONLY },
    { address: await attestationPda(input.wallet), role: AccountRole.WRITABLE },
    { address: SYSTEM, role: AccountRole.READONLY },
  ];
  return { programAddress: PROGRAM, accounts, data };
}

/** `revoke()`: config, issuer, wallet, attestation. No payer — nothing is allocated. */
export async function getRevokeInstruction(input: { issuer: TransactionSigner; wallet: Address }): Promise<Instruction & InstructionWithSigners> {
  const accounts: Accounts = [
    { address: await configPda(), role: AccountRole.READONLY },
    { address: input.issuer.address, role: AccountRole.READONLY_SIGNER, signer: input.issuer },
    { address: input.wallet, role: AccountRole.READONLY },
    { address: await attestationPda(input.wallet), role: AccountRole.WRITABLE },
  ];
  return { programAddress: PROGRAM, accounts, data: REVOKE };
}

/**
 * What the KYC service needs from the chain. Narrow on purpose: the service owns the vendor
 * contract and the idempotency, and a test fakes this whole interface rather than an RPC.
 */
export type AttestationChain = {
  attest(input: { wallet: Address; level: number; expiresAt: number; subjectHash: Uint8Array }): Promise<{ signatures: Signature[]; attestation: Address }>;
  revoke(wallet: Address): Promise<{ signatures: Signature[] }>;
  read(wallet: Address): Promise<AttestationAccount | null>;
  policy(): Promise<KycPolicy | null>;
  /** The configured issuer address, for /health and for the "is this key the issuer?" check. */
  readonly issuer: Address;
};

export function createAttestationChain(deps: {
  rpc: AttestationChainRpc;
  run: RunPlan;
  /** Pays rent and fees. Never the issuer in a real deployment (env.ts refuses that). */
  payer: TransactionSigner;
  issuer: TransactionSigner;
  log?: (...args: unknown[]) => void;
}): AttestationChain {
  const log = deps.log ?? (() => {});
  return {
    issuer: deps.issuer.address,

    async attest(input) {
      const attestation = await attestationPda(input.wallet);
      const instruction = await getAttestInstruction({ payer: deps.payer, issuer: deps.issuer, ...input });
      // The issuer signs because it is an account signer on the instruction; the payer also signs
      // as fee payer. Nothing else in the transaction, so there is nothing to co-sign for.
      const signatures = await deps.run(deps.payer, singleInstructionPlan(instruction), `attest ${input.wallet} level ${input.level}`);
      log(`kyc: attested ${input.wallet} at level ${input.level}, expires ${input.expiresAt === 0 ? "never" : input.expiresAt}`);
      return { signatures, attestation };
    },

    async revoke(wallet) {
      const instruction = await getRevokeInstruction({ issuer: deps.issuer, wallet });
      const signatures = await deps.run(deps.payer, singleInstructionPlan(instruction), `revoke attestation for ${wallet}`);
      log(`kyc: revoked the attestation for ${wallet}`);
      return { signatures };
    },

    read: (wallet) => fetchAttestation(deps.rpc, wallet),
    policy: () => fetchKycPolicy(deps.rpc),
  };
}
