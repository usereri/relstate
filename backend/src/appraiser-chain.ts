// The chain half of the appraiser registry and of the verdict: the `Appraiser` and `Dispute`
// accounts, the four instructions the backend and the setup script need, and the fee split a
// verdict will pay (docs/contracts/dispute-mediation.md §3, §4, §6).
//
// Same approach as `providers/kyc-chain.ts`, and for the same reason: no Anchor client here, so the
// discriminators and the account ORDER are reproduced by hand and pinned against the generated IDL
// in `test/appraiser-chain.test.ts`. Account names do nothing on the wire; their order is the order
// the fields are declared in the program's `#[derive(Accounts)]` struct.
//
// Two things in here are deliberately *not* new primitives:
//
//   * nothing signs for the vault. `submit_verdict` names the vault, but its only authority is the
//     lease PDA and the program signs with it (§7). The appraiser signs the verdict, never a
//     transfer.
//   * `verdictSplit` moves no money. It is this backend's copy of §6's arithmetic, used to show an
//     operator what a deduction would pay before they submit it, and asserted conservative
//     (`tenant + landlord + fee == deposit`) on every call rather than trusted.
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token-2022";
import {
  AccountRole,
  fetchEncodedAccount,
  getAddressDecoder,
  getBase58Decoder,
  getBase64Encoder,
  sequentialInstructionPlan,
  singleInstructionPlan,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type GetAccountInfoApi,
  type GetProgramAccountsApi,
  type Instruction,
  type InstructionWithSigners,
  type Rpc,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import { PROGRAM, accountDiscriminator, addressSeed, configPda, instructionDiscriminator, programDerived, sameDiscriminator } from "./anchor.ts";
import { APPRAISER_FEE_CAP_DIVISOR, UNSET_PUBKEY, hex } from "./appraisers.ts";
import { SYSTEM_PROGRAM } from "./contracts.ts";
import type { RunPlan } from "./confidential.ts";
import { accountLayout, fieldOffset, type Layout } from "./layout.ts";
import { fetchLease, type DecodedLease } from "./lease.ts";

const SYSTEM = SYSTEM_PROGRAM as Address;
const addressDecoder = getAddressDecoder();

const REGISTER_APPRAISER = instructionDiscriminator("register_appraiser");
const SET_APPRAISER_ACTIVE = instructionDiscriminator("set_appraiser_active");
const SET_DEFAULT_APPRAISER = instructionDiscriminator("set_default_appraiser");
const SUBMIT_VERDICT = instructionDiscriminator("submit_verdict");
const APPRAISER_ACCOUNT = accountDiscriminator("Appraiser");
const DISPUTE_ACCOUNT = accountDiscriminator("Dispute");

/** `[b"appraiser", wallet]` — one registry entry per company, keyed by the key that signs its verdicts. */
export const appraiserPda = (wallet: Address): Promise<Address> => programDerived("appraiser", addressSeed(wallet));
/** `[b"dispute", lease]` — exists for exactly as long as the lease is in `Mediation`. */
export const disputePda = (lease: Address): Promise<Address> => programDerived("dispute", addressSeed(lease));
/** `[b"vault", lease]` — the deposit. Its only authority is the lease PDA. */
export const vaultPda = (lease: Address): Promise<Address> => programDerived("vault", addressSeed(lease));
/** `[b"profile", wallet]` — the reputation record `submit_verdict` updates for both parties. */
export const profilePda = (wallet: Address): Promise<Address> => programDerived("profile", addressSeed(wallet));

/** An account list that may carry signers, which is what `signTransactionMessageWithSigners` reads. */
type Accounts = readonly (AccountMeta | AccountSignerMeta)[];

export type AppraiserRecord = {
  wallet: Address;
  active: boolean;
  isDefault: boolean;
  /** Base units of whichever mint the lease uses; the per-lease cap is applied by `verdictSplit`. */
  fee: bigint;
  /** Hex, lower case. `sha256(name)`; the directory in `appraisers.ts` is what it commits to. */
  nameHash: string;
};

export type DisputeRecord = {
  lease: Address;
  landlordCandidates: Address[];
  tenantCandidates: Address[];
  /** All-zero (`UNSET_PUBKEY`) until that side picks; a side may re-pick while nothing is bound. */
  landlordPick: Address;
  tenantPick: Address;
  /** The bound appraiser, or null while nothing is bound. */
  appraiser: Address | null;
  selectionDeadline: number;
  verdictDeadline: number;
};

export class AppraiserDecodeError extends Error {}

const layoutOf = (account: string): Layout => accountLayout(account);

function sized(data: Uint8Array, layout: Layout, account: string, discriminator: Uint8Array): DataView {
  if (!sameDiscriminator(data, discriminator)) {
    throw new AppraiserDecodeError(`this account is not ${account === "Appraiser" ? "an" : "a"} ${account}: its 8-byte Anchor discriminator does not match`);
  }
  if (data.length !== layout.size) {
    throw new AppraiserDecodeError(
      `expected a ${layout.size}-byte ${account} account, got ${data.length} bytes. The ${account} struct changed: ` +
        "rebuild the program (target/idl) or update FALLBACK_LAYOUTS in backend/src/layout.ts.",
    );
  }
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

export function decodeAppraiser(data: Uint8Array, layout: Layout = layoutOf("Appraiser")): AppraiserRecord {
  const view = sized(data, layout, "Appraiser", APPRAISER_ACCOUNT);
  const at = (field: string) => fieldOffset(layout, "Appraiser", field);
  return {
    wallet: addressDecoder.decode(data.subarray(at("wallet"), at("wallet") + 32)),
    active: data[at("active")] === 1,
    isDefault: data[at("is_default")] === 1,
    fee: view.getBigUint64(at("fee"), true),
    nameHash: hex(data.subarray(at("name_hash"), at("name_hash") + 32)),
  };
}

export function decodeDispute(data: Uint8Array, layout: Layout = layoutOf("Dispute")): DisputeRecord {
  const view = sized(data, layout, "Dispute", DISPUTE_ACCOUNT);
  const at = (field: string) => fieldOffset(layout, "Dispute", field);
  const address = (offset: number): Address => addressDecoder.decode(data.subarray(offset, offset + 32));
  // Only `[..count]` of each array is meaningful; the rest is zero padding the program never reads.
  const candidates = (field: string, countField: string): Address[] => {
    const base = at(field);
    const count = Math.min(data[at(countField)] ?? 0, 3);
    return Array.from({ length: count }, (_, i) => address(base + i * 32));
  };
  const appraiser = address(at("appraiser"));
  return {
    lease: address(at("lease")),
    landlordCandidates: candidates("landlord_candidates", "landlord_count"),
    tenantCandidates: candidates("tenant_candidates", "tenant_count"),
    landlordPick: address(at("landlord_pick")),
    tenantPick: address(at("tenant_pick")),
    appraiser: appraiser === UNSET_PUBKEY ? null : appraiser,
    selectionDeadline: Number(view.getBigInt64(at("selection_deadline"), true)),
    verdictDeadline: Number(view.getBigInt64(at("verdict_deadline"), true)),
  };
}

export type AppraiserRpc = Rpc<GetAccountInfoApi>;

/** The registry entry for a wallet, or null when that wallet was never registered. */
export async function fetchAppraiser(rpc: AppraiserRpc, wallet: Address): Promise<AppraiserRecord | null> {
  const account = await fetchEncodedAccount(rpc, await appraiserPda(wallet));
  return account.exists ? decodeAppraiser(account.data as Uint8Array) : null;
}

/** The mediation state of a lease, or null when the lease is not in `Mediation`. */
export async function fetchDispute(rpc: AppraiserRpc, lease: Address): Promise<DisputeRecord | null> {
  const account = await fetchEncodedAccount(rpc, await disputePda(lease));
  return account.exists ? decodeDispute(account.data as Uint8Array) : null;
}

/**
 * Which token program owns a mint, so the ATAs are derived against the right one.
 *
 * Read from the chain rather than assumed: the demo's test-USDC mint is legacy SPL Token and rUSDC
 * is Token-2022, and the two derive *different* associated addresses for the same owner and mint.
 * Guessing would send the fee to an address nobody owns.
 */
export async function fetchMintTokenProgram(rpc: AppraiserRpc, mint: Address): Promise<Address> {
  const { value } = await rpc.getAccountInfo(mint, { encoding: "base64", commitment: "confirmed" }).send();
  if (value === null) throw new AppraiserDecodeError(`no mint account at ${mint}`);
  return value.owner;
}

/**
 * The mints the Config allows leases to use: `mints: Vec<Pubkey>` right after discriminator, admin
 * and a one-byte field (same offset `kyc-chain.decodeKycPolicy` reads). Empty if Config is absent.
 */
export async function fetchAllowedMints(rpc: AppraiserRpc): Promise<Address[]> {
  const account = await fetchEncodedAccount(rpc, await configPda());
  // Not "no mints, nothing to do": a missing or short Config means the registry is not set up, and
  // a script that reported success would leave every verdict failing for want of a token account.
  if (!account.exists) throw new AppraiserDecodeError("the Config account does not exist: run scripts/setup-demo.ts (init_config) first");
  const data = account.data as Uint8Array;
  const at = 8 + 32 + 1;
  if (data.length < at + 4) throw new AppraiserDecodeError(`the Config account is ${data.length} bytes, too short to hold a mint list`);
  const count = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at, true);
  if (data.length < at + 4 + count * 32) throw new AppraiserDecodeError("the Config account's mint list runs past its end");
  return Array.from({ length: count }, (_, i) => addressDecoder.decode(data.subarray(at + 4 + i * 32, at + 36 + i * 32)));
}

/** The Config admin, read the same way: discriminator then the admin key. */
export async function fetchConfigAdmin(rpc: AppraiserRpc): Promise<Address | null> {
  const account = await fetchEncodedAccount(rpc, await configPda());
  if (!account.exists || (account.data as Uint8Array).length < 40) return null;
  return addressDecoder.decode((account.data as Uint8Array).subarray(8, 40));
}

/** Every registry entry on chain (getProgramAccounts on the Appraiser discriminator). Setup script only. */
export async function fetchAllAppraisers(rpc: Rpc<GetProgramAccountsApi>): Promise<AppraiserRecord[]> {
  const rows = await rpc
    .getProgramAccounts(PROGRAM, {
      encoding: "base64",
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 0n, bytes: getBase58Decoder().decode(APPRAISER_ACCOUNT) as never, encoding: "base58" } }],
    })
    .send();
  return (rows as unknown as { account: { data: [string, string] } }[]).map((r) => decodeAppraiser(accountBytes(r.account.data[0])));
}

/** Registry entries flagged default that the directory no longer lists: they would stay eligible for bind_default_appraiser. */
export const staleDefaults = (records: readonly AppraiserRecord[], directoryWallets: Iterable<string>): AppraiserRecord[] => {
  const keep = new Set(directoryWallets);
  return records.filter((r) => r.isDefault && !keep.has(r.wallet));
};

/** Whether an account exists. submit_verdict transfers fee_paid (even 0) to the appraiser's ATA, so it must. */
export async function accountExists(rpc: AppraiserRpc, address: Address): Promise<boolean> {
  return (await fetchEncodedAccount(rpc, address)).exists;
}

export type VerdictSplit = {
  /** `min(appraiser.fee, deposit / APPRAISER_FEE_CAP_DIVISOR)`: what the fee rule starts from. */
  fee: bigint;
  /** What the appraiser actually receives; below `fee` only when the refund could not cover it. */
  feePaid: bigint;
  toTenant: bigint;
  toLandlord: bigint;
  /** True when `2 * deduction > deposit`, i.e. the branch in which the tenant pays the fee. */
  landlordWon: boolean;
};

/**
 * §6's fee rule, as a pure function: `fee = min(appraiser.fee, deposit / 10)`, paid by whichever
 * side the verdict went against, out of the deposit.
 *
 * This is a second implementation of arithmetic the program also performs, which is a drift risk
 * worth naming. It exists because the demo console has to show what a deduction *would* pay before
 * an operator submits it, and it moves nothing: the authoritative split is the program's. It is
 * kept honest two ways — the conservation assertion below, and `test/appraiser-chain.test.ts`
 * walking both branches and every clamping edge from §6.
 */
export function verdictSplit(deposit: bigint, deduction: bigint, appraiserFee: bigint): VerdictSplit {
  if (deposit < 0n || deduction < 0n || appraiserFee < 0n) throw new Error("verdictSplit takes non-negative base-unit amounts");
  if (deduction > deposit) throw new Error(`a verdict cannot deduct ${deduction} from a deposit of ${deposit}`);

  const cap = deposit / APPRAISER_FEE_CAP_DIVISOR;
  const fee = appraiserFee < cap ? appraiserFee : cap;
  const landlordWon = 2n * deduction > deposit;

  let feePaid: bigint;
  let toTenant: bigint;
  let toLandlord: bigint;
  if (landlordWon) {
    // The tenant pays, out of a refund that may be smaller than the fee.
    const refund = deposit - deduction;
    feePaid = fee < refund ? fee : refund;
    toTenant = refund - feePaid;
    toLandlord = deduction;
  } else {
    // The landlord pays as far as their share reaches; the remainder comes out of the refund last.
    // A verdict of 0 is therefore a total win for the tenant on which the tenant still pays the
    // fee — the known limitation §6 states, and the reason the fee rule is the first cut line.
    const fromLandlord = fee < deduction ? fee : deduction;
    const fromTenant = fee - fromLandlord;
    feePaid = fee;
    toLandlord = deduction - fromLandlord;
    toTenant = deposit - deduction - fromTenant;
  }

  // Not a guard against bad input (that is checked above) but against a mistake in the branches:
  // every path must drain the vault exactly, which is invariant 1 of the contract.
  if (toTenant + toLandlord + feePaid !== deposit || toTenant < 0n || toLandlord < 0n) {
    throw new Error(`verdictSplit does not conserve the deposit: ${toTenant} + ${toLandlord} + ${feePaid} != ${deposit}`);
  }
  return { fee, feePaid, toTenant, toLandlord, landlordWon };
}

const u64 = (value: bigint): Uint8Array => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
};

/**
 * `register_appraiser(wallet, fee, name_hash)` — Config admin only.
 *
 * The admin is a *writable* signer: it pays the new account's rent as well as authorising it.
 * Accounts: admin, config, appraiser, system program.
 */
export async function getRegisterAppraiserInstruction(input: {
  admin: TransactionSigner;
  wallet: Address;
  fee: bigint;
  nameHash: Uint8Array;
}): Promise<Instruction & InstructionWithSigners> {
  if (input.nameHash.length !== 32) throw new Error(`name hash must be 32 bytes, got ${input.nameHash.length}`);
  if (input.wallet === UNSET_PUBKEY) throw new Error("the all-zero key cannot be registered as an appraiser (InvalidAppraiser)");

  const data = new Uint8Array(8 + 32 + 8 + 32);
  data.set(REGISTER_APPRAISER, 0);
  data.set(addressSeed(input.wallet), 8);
  data.set(u64(input.fee), 40);
  data.set(input.nameHash, 48);

  const accounts: Accounts = [
    { address: input.admin.address, role: AccountRole.WRITABLE_SIGNER, signer: input.admin },
    { address: await configPda(), role: AccountRole.READONLY },
    { address: await appraiserPda(input.wallet), role: AccountRole.WRITABLE },
    { address: SYSTEM, role: AccountRole.READONLY },
  ];
  return { programAddress: PROGRAM, accounts, data };
}

/** `set_appraiser_active(active)` / `set_default_appraiser(is_default)`: admin, config, appraiser. Nothing is allocated, so the admin is a read-only signer. */
async function adminFlagInstruction(discriminator: Uint8Array, admin: TransactionSigner, wallet: Address, value: boolean): Promise<Instruction & InstructionWithSigners> {
  const data = new Uint8Array(9);
  data.set(discriminator, 0);
  data[8] = value ? 1 : 0;
  const accounts: Accounts = [
    { address: admin.address, role: AccountRole.READONLY_SIGNER, signer: admin },
    { address: await configPda(), role: AccountRole.READONLY },
    { address: await appraiserPda(wallet), role: AccountRole.WRITABLE },
  ];
  return { programAddress: PROGRAM, accounts, data };
}

export const getSetAppraiserActiveInstruction = (input: { admin: TransactionSigner; wallet: Address; active: boolean }) =>
  adminFlagInstruction(SET_APPRAISER_ACTIVE, input.admin, input.wallet, input.active);

export const getSetDefaultAppraiserInstruction = (input: { admin: TransactionSigner; wallet: Address; isDefault: boolean }) =>
  adminFlagInstruction(SET_DEFAULT_APPRAISER, input.admin, input.wallet, input.isDefault);

export type SubmitVerdictInput = {
  /** The bound appraiser. Only their signature makes a verdict real; they never gain authority over the vault. */
  appraiser: TransactionSigner;
  lease: Address;
  landlord: Address;
  tenant: Address;
  mint: Address;
  tokenProgram: Address;
  deduction: bigint;
};

/**
 * `submit_verdict(deduction)`.
 *
 * Account order is the program's declaration order: appraiser, appraiser_record, lease, dispute,
 * mint, vault, tenant, tenant_ata, landlord_ata, appraiser_ata, tenant_profile, landlord_profile,
 * token_program. `tenant` is writable because the `Dispute` account's rent goes back to them when
 * it closes.
 */
export async function getSubmitVerdictInstruction(input: SubmitVerdictInput): Promise<Instruction & InstructionWithSigners> {
  if (input.deduction < 0n) throw new Error("a verdict deduction cannot be negative");
  const data = new Uint8Array(8 + 8);
  data.set(SUBMIT_VERDICT, 0);
  data.set(u64(input.deduction), 8);

  const ata = (owner: Address) => associatedToken(owner, input.mint, input.tokenProgram);
  const [record, dispute, vault, tenantAta, landlordAta, appraiserAta, tenantProfile, landlordProfile] = await Promise.all([
    appraiserPda(input.appraiser.address),
    disputePda(input.lease),
    vaultPda(input.lease),
    ata(input.tenant),
    ata(input.landlord),
    ata(input.appraiser.address),
    profilePda(input.tenant),
    profilePda(input.landlord),
  ]);

  const accounts: Accounts = [
    { address: input.appraiser.address, role: AccountRole.READONLY_SIGNER, signer: input.appraiser },
    { address: record, role: AccountRole.READONLY },
    { address: input.lease, role: AccountRole.WRITABLE },
    { address: dispute, role: AccountRole.WRITABLE },
    { address: input.mint, role: AccountRole.READONLY },
    { address: vault, role: AccountRole.WRITABLE },
    { address: input.tenant, role: AccountRole.WRITABLE },
    { address: tenantAta, role: AccountRole.WRITABLE },
    { address: landlordAta, role: AccountRole.WRITABLE },
    { address: appraiserAta, role: AccountRole.WRITABLE },
    { address: tenantProfile, role: AccountRole.WRITABLE },
    { address: landlordProfile, role: AccountRole.WRITABLE },
    { address: input.tokenProgram, role: AccountRole.READONLY },
  ];
  return { programAddress: PROGRAM, accounts, data };
}

export async function associatedToken(owner: Address, mint: Address, tokenProgram: Address): Promise<Address> {
  const [address] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
  return address;
}

/** Idempotent create of an appraiser's token account; exported so scripts/ need not import token-2022 themselves. */
export const getCreateAppraiserAtaInstruction = (input: { payer: TransactionSigner; owner: Address; mint: Address; tokenProgram: Address }) =>
  getCreateAssociatedTokenIdempotentInstructionAsync(input);

/** Re-exported for scripts/, which resolve @solana/kit only through backend/src. */
export { singleInstructionPlan };

export class VerdictRefused extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export type VerdictPlan = {
  lease: Address;
  appraiser: Address;
  deduction: bigint;
  deposit: bigint;
  split: VerdictSplit;
  /** Where the fee lands. Created idempotently by `submit`, because the program transfers to it even when the fee is 0. */
  appraiserAta: Address;
  /** False means `submit` will create it first (idempotently, paid by the fee payer). */
  appraiserAtaExists: boolean;
  mint: Address;
  tokenProgram: Address;
};

export type AppraiserChain = {
  /** Reads everything a verdict depends on and works out what it would pay. No transaction. */
  plan(input: { lease: Address; deduction: bigint }): Promise<VerdictPlan>;
  /** `plan`, then the two instructions that carry it out. */
  submit(input: { lease: Address; deduction: bigint }): Promise<{ signatures: Signature[]; plan: VerdictPlan }>;
  /** Appraiser wallets this backend holds a key for. Addresses only — a secret never leaves `keys.ts`. */
  readonly signers: Address[];
};

export function createAppraiserChain(deps: {
  rpc: AppraiserRpc;
  run: RunPlan;
  /** Pays the fee and the appraiser ATA's rent. Never an appraiser key. */
  payer: TransactionSigner;
  /** By wallet address: only a key in here can sign a verdict. */
  appraisers: ReadonlyMap<string, TransactionSigner>;
  /** Addresses that must never sign a verdict, with the role that excludes them (fee payer, treasury, issuer). */
  forbidden?: ReadonlyMap<string, string>;
  log?: (...args: unknown[]) => void;
}): AppraiserChain {
  const log = deps.log ?? (() => {});

  async function plan({ lease, deduction }: { lease: Address; deduction: bigint }): Promise<VerdictPlan> {
    const decoded: DecodedLease = await fetchLease(deps.rpc, lease, PROGRAM);
    if (decoded.status !== "mediation") {
      throw new VerdictRefused(`lease ${lease} is ${decoded.status}, not in mediation; only a lease in mediation takes a verdict`, "not-in-mediation");
    }
    if (deduction > decoded.depositAmount) {
      throw new VerdictRefused(`a verdict cannot deduct ${deduction} from a deposit of ${decoded.depositAmount}`, "deduction-above-deposit");
    }

    const dispute = await fetchDispute(deps.rpc, lease);
    if (dispute === null) throw new VerdictRefused(`lease ${lease} has no dispute account; it is not in mediation`, "no-dispute");
    if (dispute.appraiser === null) {
      throw new VerdictRefused(
        "no appraiser is bound yet: both sides must pick the same one, or anyone may bind the default once the selection window has passed",
        "appraiser-not-bound",
      );
    }
    // The registry entry, not the directory: `fee` and `active` are the program's copies, and they
    // are what the verdict will actually be judged against.
    const record = await fetchAppraiser(deps.rpc, dispute.appraiser);
    if (record === null) throw new VerdictRefused(`the bound appraiser ${dispute.appraiser} has no registry entry`, "appraiser-unregistered");
    if (!record.active) throw new VerdictRefused(`the bound appraiser ${dispute.appraiser} is suspended; the mediation can still be settled or expired`, "appraiser-inactive");

    const tokenProgram = await fetchMintTokenProgram(deps.rpc, decoded.mint);
    const appraiserAta = await associatedToken(dispute.appraiser, decoded.mint, tokenProgram);
    return {
      lease,
      appraiser: dispute.appraiser,
      deduction,
      deposit: decoded.depositAmount,
      split: verdictSplit(decoded.depositAmount, deduction, record.fee),
      appraiserAta,
      appraiserAtaExists: await accountExists(deps.rpc, appraiserAta),
      mint: decoded.mint,
      tokenProgram,
    };
  }

  return {
    signers: [...deps.appraisers.keys()] as Address[],
    plan,

    async submit(input) {
      const prepared = await plan(input);
      const signer = deps.appraisers.get(prepared.appraiser);
      if (signer === undefined) {
        throw new VerdictRefused(
          `this backend holds no key for the bound appraiser ${prepared.appraiser}; add it to APPRAISER_KEYPAIRS, or have them submit the verdict themselves`,
          "no-appraiser-key",
        );
      }
      const role = deps.forbidden?.get(prepared.appraiser);
      if (role !== undefined) {
        throw new VerdictRefused(`the bound appraiser ${prepared.appraiser} is this backend's ${role} key; a platform key must not decide a deposit`, "appraiser-is-platform-key");
      }
      if ((await fetchConfigAdmin(deps.rpc)) === prepared.appraiser) {
        throw new VerdictRefused(`the bound appraiser ${prepared.appraiser} is the Config admin; the admin must not decide a deposit`, "appraiser-is-admin");
      }
      const decoded = await fetchLease(deps.rpc, input.lease, PROGRAM);

      // The program transfers `fee_paid` — possibly 0 — to the appraiser's token account, and a
      // transfer of 0 still needs the account to exist. Idempotent, so a second verdict for the
      // same appraiser does not fail here, and the payer funds the rent, not the appraiser.
      const createAta = await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: deps.payer,
        owner: prepared.appraiser,
        mint: prepared.mint,
        tokenProgram: prepared.tokenProgram,
      });
      const verdict = await getSubmitVerdictInstruction({
        appraiser: signer,
        lease: input.lease,
        landlord: decoded.landlord,
        tenant: decoded.tenant,
        mint: prepared.mint,
        tokenProgram: prepared.tokenProgram,
        deduction: input.deduction,
      });
      const signatures = await deps.run(deps.payer, sequentialInstructionPlan([createAta, verdict]), `submit_verdict ${input.deduction} on ${input.lease}`);
      log(
        `appraiser: verdict ${input.deduction} on ${input.lease} by ${prepared.appraiser} — ` +
          `tenant ${prepared.split.toTenant}, landlord ${prepared.split.toLandlord}, fee ${prepared.split.feePaid}`,
      );
      return { signatures, plan: prepared };
    },
  };
}

/** Decodes a base64 account payload the way `getAccountInfo` returns it. Shared by the setup script. */
export const accountBytes = (data: string): Uint8Array => new Uint8Array(getBase64Encoder().encode(data));
