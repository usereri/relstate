import * as anchor from "@anchor-lang/core";
import { AnchorProvider, BN, Program } from "@anchor-lang/core";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import idl from "@target/idl/relstate.json";
import type { Relstate } from "@target/types/relstate";
import { GRACE_SECS, IS_LOCAL, MINT, PERIOD_SECS, RPC } from "./config";
import { retryingFetch } from "./rpc";
import { invalidateReads, sharedRead } from "./reads";
import { isShortPublicBalance } from "./holdback";
import { MAX_CANDIDATES, companyName, displayName, nameHashHex, nameProblem } from "./appraisers";
import { setKey } from "./mediation";
import { jsonSafe } from "./utils";
import { API, SPONSORED, postSponsored, sponsorFeePayer } from "./sponsor";
import { asWalletProvider, localKeypair, localWallet, readOnlyWallet } from "./wallet";
import type { AdapterWallet, Role, StandardWallet, WalletProvider } from "./wallet";

const { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } = anchor.web3;
type PubKey = anchor.web3.PublicKey;

export type { Role, StandardWallet, WalletProvider };
export type Status = "proposed" | "active" | "disputed" | "mediation" | "closed" | "defaulted";

export interface ListingView {
  address: string;
  id: string;
  landlord: string;
  rent: number;
  deposit: number;
  region: string;
  title: string;
  city: string;
  blurb: string;
  photo: string;
}

export interface LeaseView {
  address: string;
  id: string;
  landlord: string;
  tenant: string;
  /**
   * The mint this lease is settled in, from the lease account itself. The program pins it with
   * `has_one = mint`, and it is what decides whether rent moves publicly or confidentially
   * (docs/contracts/program-interface.md §3) — so the confidential path reads it from here rather
   * than assuming the app-wide {@link MINT}.
   */
  mint: string;
  rent: number;
  deposit: number;
  startTs: number;
  termPeriods: number;
  paidCount: number;
  periodSecs: number;
  graceSecs: number;
  hashHex: string;
  region: string;
  discountPct: number;
  status: Status;
  /** the deduction a landlord asked for while the lease is disputed, else 0 */
  proposedDeduction: number;
  /** unix seconds the current dispute OR mediation opened; 0 when the lease is neither */
  disputedAt: number;
  /** seconds the lease spent disputed; pushes back when claim_deposit opens */
  claimPauseSecs: number;
  /**
   * How many proposed deductions the tenant has rejected, up to {@link MAX_DISPUTE_ROUNDS}.
   *
   * This byte was `dispute_rejected: bool` before D2 and reads back as 0 or 1 on a lease the old
   * program wrote (docs/contracts/dispute-mediation.md §8). The last rejection escalates to
   * `Mediation` instead of returning the lease to `Active`.
   */
  disputeRounds: number;
}

/** One appraisal company a party put forward, as the `Dispute` account holds it. */
export interface CandidateView {
  /** The normalised display name, decoded from `name[..name_len]`. Never the zero padding. */
  name: string;
  /** `sha256(canonical(name))` as lower-case hex: the only thing the program compares. */
  nameHashHex: string;
  /** Base units of the lease mint, at most `deposit / APPRAISER_FEE_CAP_DIVISOR` when proposed. */
  fee: number;
}

/**
 * The `Dispute` PDA, which exists exactly while a lease is in `Mediation`
 * (docs/contracts/dispute-mediation.md §3).
 *
 * Unset pubkeys and unset hashes both arrive as `""` rather than the program's all-zero marker,
 * and each candidate list is already cut to the count the account records, so `[..count]` padding
 * never reaches a screen.
 */
export interface DisputeView {
  address: string;
  lease: string;
  landlordCandidates: CandidateView[];
  tenantCandidates: CandidateView[];
  /** The `name_hash` that side picked, hex; "" until they pick. A side may change it until agreed. */
  landlordPick: string;
  tenantPick: string;
  /** The agreed company's `name_hash`, hex; "" until both picks name the same one. */
  agreedNameHash: string;
  /** The bound fee: the lowest either side quoted for the agreed company. */
  agreedFee: number;
  /** The wallet one party has put forward for the agreed company; "" until one is proposed. */
  proposedKey: string;
  /** Which party's wallet proposed it. Only the OTHER one may confirm (`CannotConfirmOwnProposal`). */
  keyProposer: string;
  /** Proposals each party has spent of their own `MAX_KEY_PROPOSALS_PER_PARTY`. */
  landlordKeyProposals: number;
  tenantKeyProposals: number;
  /** The bound appraiser's wallet; "" until `confirm_appraiser_key` binds one. */
  appraiser: string;
  /** unix seconds; nothing may be proposed, picked or bound at or after it, and an unbound mediation expires from then on */
  selectionDeadline: number;
  /**
   * unix seconds, and **0 until an appraiser is bound** — only a binding writes it.
   *
   * So it is never a deadline on its own: every phase decision keys on `appraiser` and
   * `agreedNameHash` instead (`lib/mediation.ts`, review G2).
   */
  verdictDeadline: number;
}

export interface ProfileView {
  leasesCompleted: number;
  paidOnTime: number;
  paidLate: number;
  defaults: number;
  depositsReturnedFull: number;
  depositsClaimed: number;
  depositTotal: number;
  deductedTotal: number;
  rentPaidTotal: number;
  /** share of the latest deposit returned, in basis points (10000 = all of it) */
  lastDepositReturnBps?: number;
  /** leases that reached a deposit outcome */
  depositEvents?: number;
}

export interface ApplicationView {
  address: string;
  listing: string;
  landlord: string;
  tenant: string;
}

export interface Snapshot {
  profiles: Record<Role, ProfileView | null>;
  now: number;
}

// ---- byte offsets, derived from the IDL rather than counted by hand ---------------------
//
// A `getProgramAccounts` filter is a byte offset, and an offset that drifts from the layout does
// not fail — it silently matches nothing, which reads as "this appraiser has no cases". So the
// offsets come out of the IDL's own field list, and a test pins the two that matter.

const SCALAR_BYTES: Record<string, number> = {
  bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32,
};

type LayoutType = string | { array: [LayoutType, number] } | { defined: { name: string } };
type LayoutDef = {
  name: string;
  type: { kind: string; fields?: { name: string; type: LayoutType }[]; variants?: { name: string; fields?: unknown }[] };
};
const LAYOUTS = (idl as unknown as { types: LayoutDef[] }).types;

const layoutOf = (name: string): LayoutDef => {
  const def = LAYOUTS.find((t) => t.name === name);
  if (!def) throw new Error(`the IDL has no type named ${name}`);
  return def;
};

/** The Borsh size of a type, for the fixed-size types every account in this program is built from. */
function sizeOfType(t: LayoutType): number {
  if (typeof t === "string") {
    const size = SCALAR_BYTES[t];
    if (size === undefined) throw new Error(`no fixed Borsh size known for the IDL type ${t}`);
    return size;
  }
  if ("array" in t) return sizeOfType(t.array[0]) * t.array[1];
  const def = layoutOf(t.defined.name);
  // A data-carrying enum has no fixed size; a plain one is a single discriminant byte (`Status`).
  if (def.type.kind === "enum") {
    if (def.type.variants?.some((v) => v.fields)) throw new Error(`${def.name} is a data-carrying enum, so it has no fixed size`);
    return 1;
  }
  return (def.type.fields ?? []).reduce((n, f) => n + sizeOfType(f.type), 0);
}

/** Where a field starts inside an account, Anchor's 8-byte discriminator included. */
export function fieldOffset(account: string, field: string): number {
  let at = 8;
  for (const f of layoutOf(account).type.fields ?? []) {
    if (f.name === field) return at;
    at += sizeOfType(f.type);
  }
  throw new Error(`the IDL's ${account} has no field named ${field}`);
}

/** The whole account, discriminator included: 891 bytes for `Dispute` (§3). */
export const accountSize = (account: string): number => 8 + sizeOfType({ defined: { name: account } });

/** Single source of truth: the program's constants, read from the IDL. */
const constant = (name: string) => Number(idl.constants.find((c) => c.name === name)!.value);
export const DISCOUNT_PCT = constant("GOOD_STANDING_DISCOUNT_PCT");
export const RENT_HEADROOM_PCT = constant("RENT_HEADROOM_PCT");
/** How long a tenant has to answer a proposed deduction. Build-dependent (demo 15 s, release 14 days), so it comes from the IDL. */
export const DISPUTE_WINDOW_SECS = constant("DISPUTE_WINDOW_SECS");
/** Rejections the tenant gets before the decision stops being the parties' (docs/contracts/dispute-mediation.md §1). */
export const MAX_DISPUTE_ROUNDS = constant("MAX_DISPUTE_ROUNDS");
/** How long the two sides have to agree on an appraiser. Demo 30 s, release 7 days. */
export const SELECTION_WINDOW_SECS = constant("SELECTION_WINDOW_SECS");
/** How long the bound appraiser has to submit a verdict, from the moment they are bound. Demo 60 s, release 14 days. */
export const VERDICT_WINDOW_SECS = constant("VERDICT_WINDOW_SECS");
/** The appraiser's fee is capped at `deposit / this` per lease. */
export const APPRAISER_FEE_CAP_DIVISOR = constant("APPRAISER_FEE_CAP_DIVISOR");

// Previews of Profile::good_standing / typical_rent / deserves_discount in the program;
// the program applies the real rule at propose_lease.
export const goodStanding = (p: ProfileView | null) =>
  !!p && p.leasesCompleted >= 1 && p.paidLate === 0 && p.defaults === 0;

/** Average rent per payment: the rent level this tenant has proven (base units). */
export const typicalRent = (p: ProfileView | null) => {
  const payments = p ? p.paidOnTime + p.paidLate : 0;
  return p && payments ? Math.floor(p.rentPaidTotal / payments) : 0;
};

/** The highest rent the discount still covers. */
export const maxDiscountRent = (p: ProfileView | null) => Math.floor((typicalRent(p) * RENT_HEADROOM_PCT) / 100);

export const qualifiesForDiscount = (p: ProfileView | null, rent: number) =>
  goodStanding(p) && rent <= maxDiscountRent(p);

/**
 * A lease that is still running: anything that is not `closed` or `defaulted`.
 *
 * One place, because the list grew a member (`mediation`) and every screen that filtered for
 * "current" leases by naming the other four silently dropped the new one.
 */
export const inProgress = (s: Status) => s === "proposed" || s === "active" || s === "disputed" || s === "mediation";

export const isWallet = (s: string) => {
  try {
    return new PublicKey(s).toBytes().length === 32;
  } catch {
    return false;
  }
};

export const connection = new Connection(RPC, { commitment: "confirmed", fetch: retryingFetch });
const mint = new PublicKey(MINT);

/** Re-exported so call sites keep reaching the wallet contract through `chain`. */
export { localKeypair, localWallet };
export const LOCAL_WALLETS_AVAILABLE = IS_LOCAL;

/** True when the backend pays every fee, so the connected wallet needs no SOL at all. */
export { API, SPONSORED };

/**
 * The confidential-balance island, loaded on demand.
 *
 * It is a whole second Solana stack (`@solana/kit` + the `@solana/zk-sdk` wasm), so it is a
 * dynamic import rather than part of the main bundle: nobody who never pays rent privately
 * downloads the proof machinery. Every caller reaches it through here.
 */
export const confidential = () => import("./confidential");

export interface Me {
  key: PubKey;
  program: Program<Relstate>;
  wallet: WalletProvider;
}

/**
 * Which token program owns the lease mint.
 *
 * The program moved from `anchor_spl::token::Token`, which had one known address the Anchor
 * client could infer, to `Interface<TokenInterface>`, which accepts both token programs and so
 * cannot be inferred (docs/contracts/program-interface.md §1). Every instruction that moves
 * tokens now has to name it, and the associated-token address depends on it too, so both come
 * from the mint account itself rather than a hard-coded guess.
 *
 * Only a successful read is cached. A failed one — an RPC blip, a 429 that outlived its retries,
 * or a mint that does not exist yet — must not pin the session to a guess: on a Token-2022 mint
 * that would derive wrong ATAs until the page reloaded. So a failure clears the cache and is
 * raised to the caller, which fails the flow with a message naming the mint instead of sending a
 * transaction built against the wrong token program.
 */
const resolving = new Map<string, Promise<PubKey>>();

/**
 * Which token program owns `which` mint. Keyed per mint, because a lease carries its own mint
 * (`LeaseView.mint`) and the confidential rent path has to derive that mint's ATAs, not the
 * app-wide one's.
 */
export function tokenProgramOf(which: PubKey | string): Promise<PubKey> {
  const key = typeof which === "string" ? which : which.toBase58();
  const held = resolving.get(key);
  if (held) return held;
  const pending = connection
    .getAccountInfo(new PublicKey(key))
    .then((info) => {
      if (!info) throw new Error(`The lease mint ${key} does not exist on ${RPC}.`);
      return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    })
    .catch((e) => {
      resolving.delete(key);
      throw e;
    });
  resolving.set(key, pending);
  return pending;
}

export const tokenProgram = (): Promise<PubKey> => tokenProgramOf(MINT);

const ataWith = (wallet: PubKey, program: PubKey) => getAssociatedTokenAddressSync(mint, wallet, false, program);

/** The lease mint's associated token account for a wallet, on whichever token program owns it. */
export const tokenAccountFor = async (wallet: PubKey) => ataWith(wallet, await tokenProgram());

/** The same, for an arbitrary mint: the accounts a confidential transfer on a lease mint names. */
export const tokenAccountOn = async (which: PubKey | string, wallet: PubKey) =>
  getAssociatedTokenAddressSync(new PublicKey(which), wallet, false, await tokenProgramOf(which));

export function makeMe(w: WalletProvider | AdapterWallet): Me {
  const wallet = asWalletProvider(w);
  const provider = new AnchorProvider(connection, wallet as never, { commitment: "confirmed" });
  return { key: wallet.publicKey, program: new Program<Relstate>(idl as Relstate, provider), wallet };
}

const reader = new Program<Relstate>(idl as Relstate, new AnchorProvider(connection, readOnlyWallet() as never, { commitment: "confirmed" }));
const programId = reader.programId;

const u64 = (n: BN) => n.toArrayLike(Buffer, "le", 8);
const pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const leasePda = (landlord: PubKey, id: string) => pda(Buffer.from("lease"), landlord.toBuffer(), u64(new BN(id)));
const listingPda = (landlord: PubKey, id: string) => pda(Buffer.from("listing"), landlord.toBuffer(), u64(new BN(id)));
const vaultPda = (lease: PubKey) => pda(Buffer.from("vault"), lease.toBuffer());
const profilePda = (wallet: PubKey) => pda(Buffer.from("profile"), wallet.toBuffer());
const applicationPda = (listing: PubKey, tenant: PubKey) => pda(Buffer.from("application"), listing.toBuffer(), tenant.toBuffer());
const disputePda = (lease: PubKey) => pda(Buffer.from("dispute"), lease.toBuffer());

export const leaseAddress = (landlord: string, id: string) => leasePda(new PublicKey(landlord), id).toBase58();
export const newId = () => String(Date.now());


type Acc<K extends "lease" | "profile" | "listing" | "application" | "dispute"> = NonNullable<Awaited<ReturnType<(typeof reader.account)[K]["fetchNullable"]>>>;

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
/** A 32-byte hash the program has actually written, or "" for its all-zero "unset" marker. */
const setHash = (bytes: number[]) => {
  const h = hex(bytes);
  return /^0+$/.test(h) ? "" : h;
};
const code = (region: number[]) => String.fromCharCode(...region);

const listingView = (address: PubKey, l: Acc<"listing">): ListingView => ({
  address: address.toBase58(),
  id: l.listingId.toString(),
  landlord: l.landlord.toBase58(),
  rent: l.rentAmount.toNumber(),
  deposit: l.depositAmount.toNumber(),
  region: code(l.region),
  title: l.title,
  city: l.city,
  blurb: l.blurb,
  photo: l.photo,
});

const leaseView = (address: PubKey, l: Acc<"lease">): LeaseView => ({
  address: address.toBase58(),
  id: l.leaseId.toString(),
  landlord: l.landlord.toBase58(),
  tenant: l.tenant.toBase58(),
  mint: l.mint.toBase58(),
  rent: l.rentAmount.toNumber(),
  deposit: l.depositAmount.toNumber(),
  startTs: l.startTs.toNumber(),
  termPeriods: l.termPeriods,
  paidCount: l.paidCount,
  periodSecs: l.periodSecs.toNumber(),
  graceSecs: l.graceSecs.toNumber(),
  hashHex: hex(l.leaseHash),
  region: code(l.region),
  discountPct: l.discountPct,
  status: Object.keys(l.status)[0] as Status,
  proposedDeduction: l.proposedDeduction.toNumber(),
  disputedAt: l.disputedAt.toNumber(),
  claimPauseSecs: l.claimPauseSecs.toNumber(),
  disputeRounds: l.disputeRounds,
});

/**
 * One candidate slot, decoded.
 *
 * `name` is a fixed 64-byte array of which only `[..name_len]` is meaningful; the rest is zero
 * padding that would decode as NUL characters. The slice is clamped to the array itself as well as
 * to `name_len`, so a length byte larger than the array could not reach a screen.
 */
const candidateView = (c: Acc<"dispute">["landlordCandidates"][number]): CandidateView => ({
  name: companyName(new TextDecoder().decode(new Uint8Array(c.name.slice(0, Math.min(c.nameLen, c.name.length))))),
  nameHashHex: hex(c.nameHash),
  fee: c.fee.toNumber(),
});

const disputeView = (address: PubKey, d: Acc<"dispute">): DisputeView => ({
  address: address.toBase58(),
  lease: d.lease.toBase58(),
  landlordCandidates: d.landlordCandidates.slice(0, d.landlordCount).map(candidateView),
  tenantCandidates: d.tenantCandidates.slice(0, d.tenantCount).map(candidateView),
  landlordPick: setHash(d.landlordPick),
  tenantPick: setHash(d.tenantPick),
  agreedNameHash: setHash(d.agreedNameHash),
  agreedFee: d.agreedFee.toNumber(),
  proposedKey: setKey(d.proposedKey.toBase58()),
  keyProposer: setKey(d.keyProposer.toBase58()),
  landlordKeyProposals: d.landlordKeyProposals,
  tenantKeyProposals: d.tenantKeyProposals,
  appraiser: setKey(d.appraiser.toBase58()),
  selectionDeadline: d.selectionDeadline.toNumber(),
  verdictDeadline: d.verdictDeadline.toNumber(),
});

const profileView = (p: Acc<"profile"> | null): ProfileView | null =>
  p && {
    leasesCompleted: p.leasesCompleted,
    paidOnTime: p.paidOnTime,
    paidLate: p.paidLate,
    defaults: p.defaults,
    depositsReturnedFull: p.depositsReturnedFull,
    depositsClaimed: p.depositsClaimed,
    depositTotal: p.depositTotal.toNumber(),
    deductedTotal: p.deductedTotal.toNumber(),
    rentPaidTotal: p.rentPaidTotal.toNumber(),
    lastDepositReturnBps: p.lastDepositReturnBps,
    depositEvents: p.depositEvents,
  };

const applicationView = (address: PubKey, a: Acc<"application">): ApplicationView => ({
  address: address.toBase58(),
  listing: a.listing.toBase58(),
  landlord: a.landlord.toBase58(),
  tenant: a.tenant.toBase58(),
});

const newestFirst = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => Number(b.id) - Number(a.id));

export function loadListings(): Promise<ListingView[]> {
  return sharedRead("listings", async () => newestFirst((await reader.account.listing.all()).map((r) => listingView(r.publicKey, r.account))));
}

// Key offsets in an application: landlord 40, tenant 72. Applications for a landlord's listings, or made by a tenant.
export function loadApplications(who: { landlord: string } | { tenant: string }): Promise<ApplicationView[]> {
  const [offset, wallet] = "landlord" in who ? [40, who.landlord] : [72, who.tenant];
  return sharedRead(`applications:${offset}:${wallet}`, async () => {
    const rows = await reader.account.application.all([{ memcmp: { offset, bytes: new PublicKey(wallet).toBase58() } }]);
    return rows.map((r) => applicationView(r.publicKey, r.account));
  });
}

export function loadLeases(wallet: string, role: Role): Promise<LeaseView[]> {
  return sharedRead(`leases:${role}:${wallet}`, async () => {
    const bytes = new PublicKey(wallet).toBase58();
    const rows = await reader.account.lease.all([{ memcmp: { offset: role === "landlord" ? 8 : 40, bytes } }]);
    return newestFirst(rows.map((r) => leaseView(r.publicKey, r.account)));
  });
}

/**
 * One lease by address, for the appraiser's page: an appraiser is neither party, so they cannot
 * find their cases through {@link loadLeases}, which scans by landlord or tenant.
 */
export function loadLease(address: string): Promise<LeaseView | null> {
  return sharedRead(`lease:${address}`, async () => {
    const key = new PublicKey(address);
    const l = await reader.account.lease.fetchNullable(key);
    return l && leaseView(key, l);
  });
}

/** The mediation of one lease, or null when it is not in `Mediation` (the PDA only exists then). */
export function loadDispute(leaseAddress: string): Promise<DisputeView | null> {
  return sharedRead(`dispute:${leaseAddress}`, async () => {
    const address = disputePda(new PublicKey(leaseAddress));
    const d = await reader.account.dispute.fetchNullable(address);
    return d && disputeView(address, d);
  });
}

/** Where `Dispute.appraiser` starts, for the scan below. 842 bytes in, and pinned by a test. */
const APPRAISER_OFFSET = fieldOffset("Dispute", "appraiser");

/**
 * Every mediation this wallet is the bound appraiser of.
 *
 * The appraiser's own case list, and the only way they can have one: they are not a party to any
 * lease, so nothing on chain points from their wallet to the dispute, and there is no backend that
 * holds the mapping either. A `memcmp` on `Dispute.appraiser` is the whole index — it works for a
 * wallet created five minutes ago, needs no registry, and cannot show a case somebody else's
 * verdict would decide.
 */
export function loadDisputesFor(appraiser: string): Promise<DisputeView[]> {
  return sharedRead(`disputes:appraiser:${appraiser}`, async () => {
    const rows = await reader.account.dispute.all([{ memcmp: { offset: APPRAISER_OFFSET, bytes: new PublicKey(appraiser).toBase58() } }]);
    return rows.map((r) => disputeView(r.publicKey, r.account));
  });
}

export function loadProfile(address: string): Promise<ProfileView | null> {
  return sharedRead(`profile:${address}`, async () => profileView(await reader.account.profile.fetchNullable(profilePda(new PublicKey(address)))));
}

export async function loadNow(): Promise<number> {
  const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  return clock ? Number(clock.data.readBigInt64LE(32)) : Math.floor(Date.now() / 1000);
}

export async function loadBalances(wallet: string): Promise<{ sol: number; usdc: number | null }> {
  const key = new PublicKey(wallet);
  const [lamports, usdc] = await Promise.all([
    connection.getBalance(key),
    tokenProgram()
      .then(async (program) => getAccount(connection, ataWith(key, program), undefined, program))
      .then(
        (a) => Number(a.amount),
        () => null,
      ),
  ]);
  return { sol: lamports / anchor.web3.LAMPORTS_PER_SOL, usdc };
}

export interface NewListing {
  rent: number;
  deposit: number;
  region: string;
  title: string;
  city: string;
  blurb: string;
  photo: string;
}

// The compute budget every sponsored transaction carries (docs/wallet-simulation.md, "Compute
// budget"). A wallet that finds none may add its own while signing: Phantom prepended a limit and
// a 375,000 micro-lamport priority fee on devnet, which the sponsor's default price cap refuses,
// and its prompt took over 30 s to appear while it did. Setting both here leaves it nothing to add.
//
// Both stay inside the sponsor's default caps (`SPONSOR_MAX_COMPUTE_UNITS` 400,000,
// `SPONSOR_MAX_CU_PRICE_MICROLAMPORTS` 10,000), so a backend running the defaults accepts them.
// The limit is the runtime's own default for one or two instructions (200,000 each) and stops at
// the sponsor's cap above that, which the sponsor's simulation already enforced on what a
// transaction may consume; the price adds at most 400 lamports to the fee.
export const SPONSORED_CU_PER_INSTRUCTION = 200_000;
export const SPONSORED_MAX_COMPUTE_UNITS = 400_000;
export const SPONSORED_CU_PRICE_MICRO_LAMPORTS = 1_000;

const instructionKey = (ix: anchor.web3.TransactionInstruction) => `${ix.programId.toBase58()}:${ix.data.toString("base64")}`;

/** Prepends a compute-unit limit and price, unless the transaction already sets a budget. */
export function withComputeBudget(tx: anchor.web3.Transaction): anchor.web3.Transaction {
  const { ComputeBudgetProgram } = anchor.web3;
  if (tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))) return tx;
  const units = Math.min(SPONSORED_CU_PER_INSTRUCTION * tx.instructions.length, SPONSORED_MAX_COMPUTE_UNITS);
  tx.instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SPONSORED_CU_PRICE_MICRO_LAMPORTS }),
    ...tx.instructions,
  ];
  return tx;
}

/**
 * Contract 2: hand a transaction to the backend, which pays the fee and submits it, so the
 * user never needs SOL.
 *
 * The fee payer's address is part of what the user signs, so it is filled in here and only its
 * signature slot is left empty — that is what "fee payer empty" means on the wire.
 */
export async function sendSponsored(me: Me, tx: anchor.web3.Transaction): Promise<string> {
  withComputeBudget(tx);
  const [feePayer, latest] = await Promise.all([sponsorFeePayer(), connection.getLatestBlockhash("confirmed")]);
  tx.feePayer = new PublicKey(feePayer);
  tx.recentBlockhash = latest.blockhash;
  tx.lastValidBlockHeight = latest.lastValidBlockHeight;
  const requested = { blockhash: tx.recentBlockhash, instructions: tx.instructions.map(instructionKey) };
  const requestedAt = Date.now();
  const signed = await me.wallet.signTransaction(tx);
  // Diagnostic: a wallet may rewrite the message while signing (compute budget, blockhash). The
  // budget above should leave it nothing to change; say so if it changed something anyway.
  const signedInstructions = signed.instructions.map(instructionKey);
  if (
    signed.recentBlockhash !== requested.blockhash ||
    signedInstructions.length !== requested.instructions.length ||
    signedInstructions.some((key, i) => key !== requested.instructions[i])
  ) {
    console.warn(
      `[sponsor] wallet modified the transaction: blockhash ${requested.blockhash} -> ${signed.recentBlockhash}, ` +
        `${requested.instructions.length} -> ${signedInstructions.length} instructions`,
    );
  }
  console.info(`[sponsor] blockhash ${signed.recentBlockhash}, signed after ${Date.now() - requestedAt} ms, ${signed.instructions.length} instructions`);
  return postSponsored(signed.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"));
}

type Call = {
  simulate: () => Promise<unknown>;
  rpc: () => Promise<string>;
  transaction: () => Promise<anchor.web3.Transaction>;
};

/**
 * Every flow goes through here. With a backend configured (VITE_API) the transaction is
 * sponsored; without one the connected wallet pays its own fee, which is what keeps the local
 * test-wallet flow working unchanged.
 *
 * Simulation moves to the backend in sponsored mode — the hardening spec puts it there, and a
 * wallet with 0 SOL cannot be the fee payer of a client-side simulation.
 */
async function send(me: Me, call: Call) {
  try {
    if (!SPONSORED) {
      await call.simulate();
      return await call.rpc();
    }
    return await sendSponsored(me, await call.transaction());
  } finally {
    // What the shared reads hold is stale once a transaction has been tried.
    invalidateReads();
  }
}

export function createListing(me: Me, id: string, f: NewListing) {
  return send(me, me.program.methods
    .createListing(new BN(id), new BN(f.rent), new BN(f.deposit), Array.from(f.region, (c) => c.charCodeAt(0)), f.title, f.city, f.blurb, f.photo)
    .accountsPartial({ landlord: me.key, listing: listingPda(me.key, id) }));
}

export function closeListing(me: Me, l: ListingView) {
  return send(me, me.program.methods
    .closeListing()
    .accountsPartial({ landlord: me.key, listing: new PublicKey(l.address) }));
}

export function applyTo(me: Me, l: ListingView) {
  const listing = new PublicKey(l.address);
  return send(me, me.program.methods
    .apply()
    .accountsPartial({ tenant: me.key, listing, application: applicationPda(listing, me.key) }));
}

const closeApplicationCall = (me: Me, a: ApplicationView) =>
  me.program.methods
    .closeApplication()
    .accountsPartial({ signer: me.key, application: new PublicKey(a.address), tenant: new PublicKey(a.tenant) });

// Either the applicant (withdraw) or the landlord (dismiss).
export function closeApplication(me: Me, a: ApplicationView) {
  return send(me, closeApplicationCall(me, a));
}

// When the tenant had applied, the application is closed in the same transaction.
export async function proposeLease(me: Me, id: string, l: ListingView, tenant: string, hash: number[], term: number, application?: ApplicationView) {
  const tenantKey = new PublicKey(tenant);
  const lease = leasePda(me.key, id);
  const tokenProgramId = await tokenProgram();
  const call = me.program.methods
    .proposeLease(
      new BN(id),
      new BN(l.rent),
      new BN(l.deposit),
      new BN(PERIOD_SECS),
      new BN(GRACE_SECS),
      term,
      hash,
      Array.from(l.region, (c) => c.charCodeAt(0)),
    )
    .accountsPartial({
      landlord: me.key,
      tenant: tenantKey,
      tenantProfile: profilePda(tenantKey),
      mint,
      lease,
      vault: vaultPda(lease),
      landlordProfile: profilePda(me.key),
      tokenProgram: tokenProgramId,
    });
  return send(me, application ? call.postInstructions([await closeApplicationCall(me, application).instruction()]) : call);
}

// Accepting the lease also closes the tenant's open applications to this landlord (same transaction),
// so nothing stale is left to withdraw.
export async function fundDeposit(me: Me, l: LeaseView, hash: number[], applications: ApplicationView[] = []) {
  const lease = new PublicKey(l.address);
  const tokenProgramId = await tokenProgram();
  const call = me.program.methods
    .fundDeposit(hash)
    .accountsPartial({
      tenant: me.key,
      lease,
      mint,
      vault: vaultPda(lease),
      tenantAta: await tokenAccountFor(me.key),
      tenantProfile: profilePda(me.key),
      tokenProgram: tokenProgramId,
    });
  const closes = await Promise.all(applications.map((a) => closeApplicationCall(me, a).instruction()));
  return send(me, closes.length ? call.postInstructions(closes) : call);
}

/**
 * The public rent path: `pay_rent` moves `rent_amount` itself. On a confidential mint the program
 * moves nothing and instead expects a confidential transfer directly before this instruction --
 * that transaction is built by `confidential.ts` and composed by the caller, not here.
 */
export async function payRent(me: Me, l: LeaseView) {
  const [tokenProgramId, tenantAta, landlordAta] = await Promise.all([
    tokenProgram(),
    tokenAccountFor(me.key),
    tokenAccountFor(new PublicKey(l.landlord)),
  ]);
  return send(me, me.program.methods
    .payRent()
    .accountsPartial({
      tenant: me.key,
      lease: new PublicKey(l.address),
      mint,
      tenantAta,
      landlordAta,
      tenantProfile: profilePda(me.key),
      tokenProgram: tokenProgramId,
    }));
}

/**
 * `pay_rent` as a bare instruction, built against the lease's own mint.
 *
 * The confidential path cannot use {@link payRent}: the program matches the Token-2022 transfer by
 * POSITION — it must be the instruction directly before this one — so `pay_rent` has to be spliced
 * into a transaction the confidential planner built, not sent on its own
 * (docs/contracts/program-interface.md §3). `lib/pay.ts` does the splicing.
 */
export async function payRentInstruction(me: Me, l: LeaseView): Promise<anchor.web3.TransactionInstruction> {
  const leaseMint = new PublicKey(l.mint);
  const [tokenProgramId, tenantAta, landlordAta] = await Promise.all([
    tokenProgramOf(leaseMint),
    tokenAccountOn(leaseMint, me.key),
    tokenAccountOn(leaseMint, new PublicKey(l.landlord)),
  ]);
  return me.program.methods
    .payRent()
    .accountsPartial({
      tenant: me.key,
      lease: new PublicKey(l.address),
      mint: leaseMint,
      tenantAta,
      landlordAta,
      tenantProfile: profilePda(me.key),
      tokenProgram: tokenProgramId,
    })
    .instruction();
}

export async function releaseDeposit(me: Me, l: LeaseView, deduction: number) {
  const lease = new PublicKey(l.address);
  const tenant = new PublicKey(l.tenant);
  const [tokenProgramId, tenantAta, landlordAta] = await Promise.all([tokenProgram(), tokenAccountFor(tenant), tokenAccountFor(me.key)]);
  return send(me, me.program.methods
    .releaseDeposit(new BN(deduction))
    .accountsPartial({
      landlord: me.key,
      lease,
      mint,
      vault: vaultPda(lease),
      tenantAta,
      landlordAta,
      tenantProfile: profilePda(tenant),
      landlordProfile: profilePda(me.key),
      tokenProgram: tokenProgramId,
    }));
}

export async function markDefault(me: Me, l: LeaseView) {
  const lease = new PublicKey(l.address);
  const tenant = new PublicKey(l.tenant);
  const [tokenProgramId, tenantAta, landlordAta] = await Promise.all([tokenProgram(), tokenAccountFor(tenant), tokenAccountFor(me.key)]);
  return send(me, me.program.methods
    .markDefault()
    .accountsPartial({
      landlord: me.key,
      lease,
      mint,
      vault: vaultPda(lease),
      tenantAta,
      landlordAta,
      tenantProfile: profilePda(tenant),
      landlordProfile: profilePda(me.key),
      tokenProgram: tokenProgramId,
    }));
}

export async function claimDeposit(me: Me, l: LeaseView) {
  const lease = new PublicKey(l.address);
  const landlord = new PublicKey(l.landlord);
  const [tokenProgramId, tenantAta, landlordAta] = await Promise.all([tokenProgram(), tokenAccountFor(me.key), tokenAccountFor(landlord)]);
  return send(me, me.program.methods
    .claimDeposit()
    .accountsPartial({
      tenant: me.key,
      lease,
      mint,
      vault: vaultPda(lease),
      tenantAta,
      landlordAta,
      tenantProfile: profilePda(me.key),
      landlordProfile: profilePda(landlord),
      tokenProgram: tokenProgramId,
    }));
}

/** The tenant agrees to the deduction the landlord proposed: the deposit is split and the lease closes. */
export async function acceptDeduction(me: Me, l: LeaseView) {
  const lease = new PublicKey(l.address);
  const landlord = new PublicKey(l.landlord);
  const [tokenProgramId, tenantAta, landlordAta] = await Promise.all([tokenProgram(), tokenAccountFor(me.key), tokenAccountFor(landlord)]);
  return send(me, me.program.methods
    .acceptDeduction()
    .accountsPartial({
      tenant: me.key,
      lease,
      mint,
      vault: vaultPda(lease),
      tenantAta,
      landlordAta,
      tenantProfile: profilePda(me.key),
      landlordProfile: profilePda(landlord),
      tokenProgram: tokenProgramId,
    }));
}

/**
 * The tenant rejects the proposed deduction while rounds are left: the proposal is void, the lease
 * returns to `Active` with the claim clock resumed, and the landlord may propose once more.
 *
 * Refused with `WrongDisputeRound` on the last round — that rejection is
 * {@link escalateToMediation}, which is a different instruction because it does a different thing.
 */
export function abandonDispute(me: Me, l: LeaseView) {
  return send(me, me.program.methods.abandonDispute().accountsPartial({ tenant: me.key, lease: new PublicKey(l.address) }));
}

/**
 * The last rejection: the lease enters `Mediation`, the deposit stays locked and an appraiser
 * decides. Creates the `Dispute` PDA, which the tenant pays the rent for and gets back on every
 * exit (docs/contracts/dispute-mediation.md §3).
 */
export function escalateToMediation(me: Me, l: LeaseView) {
  const lease = new PublicKey(l.address);
  return send(me, me.program.methods
    .escalateToMediation()
    .accountsPartial({ tenant: me.key, lease, dispute: disputePda(lease) }));
}

/** A company name and what it quoted, as the proposal form collects them. */
export interface CompanyQuote {
  name: string;
  /** Base units of the lease mint. 0 is allowed and means "no quote given". */
  fee: number;
}

/**
 * One side names up to three appraisal companies, by name, with a fee each. Once per side.
 *
 * There is no registry to choose from in revision 2: these are strings the party typed, and the
 * program normalises and hashes each one itself (`Candidate::new`). Everything checked here is
 * checked again on chain — the point is that somebody who mistyped a name, listed the same company
 * twice or quoted above the cap learns it from this screen instead of from a failed transaction,
 * because **a side only gets one call** and a refused one is a wasted hand-off inside a window
 * measured in seconds on the demo build.
 */
export function proposeAppraisers(me: Me, l: LeaseView, companies: CompanyQuote[]) {
  if (companies.length === 0) throw new Error("Name at least one appraisal company.");
  if (companies.length > MAX_CANDIDATES)
    throw new Error(`A side may name at most ${MAX_CANDIDATES} companies, and ${companies.length} were given.`);
  const cap = Math.floor(l.deposit / APPRAISER_FEE_CAP_DIVISOR);
  const seen = new Set<string>();
  const candidates = companies.map(({ name, fee }) => {
    const problem = nameProblem(name);
    if (problem) throw new Error(problem);
    const display = displayName(name);
    const hash = nameHashHex(name);
    // The program compares hashes, so two rows that differ only in case or spacing are one company
    // to it and the second is `DuplicateCandidate`.
    if (seen.has(hash)) throw new Error(`"${display}" is in your list twice — the same name, ignoring capitals and spacing.`);
    seen.add(hash);
    if (!Number.isSafeInteger(fee) || fee < 0) throw new Error(`The fee for "${display}" is not a whole amount.`);
    if (fee > cap) throw new Error(`The fee for "${display}" is above a tenth of the deposit, which is the most an appraiser may be paid from it.`);
    return { name: display, fee: new BN(fee) };
  });
  const lease = new PublicKey(l.address);
  return send(me, me.program.methods
    .proposeAppraisers(candidates)
    .accountsPartial({ party: me.key, lease, dispute: disputePda(lease) }));
}

/**
 * This side names the company it wants, from either list. The same name from both sides agrees it,
 * along with the lower of the two fees; a side may change its pick until then.
 *
 * The normalised form is sent rather than the raw string, so what the screen showed is what gets
 * hashed — the program would normalise it anyway, and sending the display form keeps the two from
 * ever disagreeing about which company was picked.
 */
export function pickAppraiser(me: Me, l: LeaseView, name: string) {
  const problem = nameProblem(name);
  if (problem) throw new Error(problem);
  const lease = new PublicKey(l.address);
  return send(me, me.program.methods
    .pickAppraiser(displayName(name))
    .accountsPartial({ party: me.key, lease, dispute: disputePda(lease) }));
}

/**
 * The wallet of the party-chosen appraiser, as checked before it is sent.
 *
 * All three conditions are the program's (`InvalidAppraiserKey`, `NotMediationParty`), and the
 * party exclusion is the one worth catching here: pasting your own address is an easy mistake, and
 * the program's refusal of it reads as being told you are not a party to your own lease.
 */
function appraiserWallet(l: LeaseView, wallet: string): PubKey {
  const trimmed = wallet.trim();
  if (!isWallet(trimmed)) throw new Error("That is not a valid account address. Copy it from the invitation, or from what the appraiser sent you.");
  const key = new PublicKey(trimmed);
  if (key.equals(PublicKey.default)) throw new Error("That is the all-zero address, which nobody holds and which cannot sign anything.");
  if (trimmed === l.landlord || trimmed === l.tenant)
    throw new Error("That is this lease's own landlord or tenant. The appraiser has to be somebody else — the program refuses a verdict from either of you.");
  return key;
}

/**
 * Phase 2, first half: this party puts forward the wallet that will sign for the agreed company.
 *
 * Each party has their own budget of {@link MAX_KEY_PROPOSALS_PER_PARTY} proposals, so one side can
 * never burn the other's and the other can always counter-propose (§4, review G4). Nothing here
 * moves a deadline: all of phase 2 is inside `selection_deadline`.
 */
export function proposeAppraiserKey(me: Me, l: LeaseView, wallet: string) {
  const key = appraiserWallet(l, wallet);
  const lease = new PublicKey(l.address);
  return send(me, me.program.methods
    .proposeAppraiserKey(key)
    .accountsPartial({ party: me.key, lease, dispute: disputePda(lease) }));
}

/**
 * Phase 2, second half: the party that did NOT propose confirms the same wallet, which binds the
 * appraiser and starts the verdict window.
 *
 * The wallet goes as an argument rather than "whatever is proposed", so a proposer who swaps the
 * key in the slot the other party is confirming cannot bind a wallet the confirmer never looked
 * at: that confirmation fails with `KeyMismatch` instead (§4).
 */
export function confirmAppraiserKey(me: Me, l: LeaseView, wallet: string) {
  const key = appraiserWallet(l, wallet);
  const lease = new PublicKey(l.address);
  return send(me, me.program.methods
    .confirmAppraiserKey(key)
    .accountsPartial({ party: me.key, lease, dispute: disputePda(lease) }));
}

/**
 * The selection ran out, or the bound appraiser stayed silent past their window: either party
 * returns the lease to `Active` with the claim clock resumed, and the tenant then takes the whole
 * deposit through `claim_deposit`. The `Dispute` account closes and its rent goes back to the
 * tenant, which is why they are named.
 */
export function expireMediation(me: Me, l: LeaseView) {
  const lease = new PublicKey(l.address);
  return send(me, me.program.methods
    .expireMediation()
    .accountsPartial({ party: me.key, lease, dispute: disputePda(lease), tenant: new PublicKey(l.tenant) }));
}

/**
 * The bound appraiser signs one number, and the program splits the vault on it (§4 phase 3, §6).
 *
 * **The create-idempotent comes first, and the fee payer pays its rent.** `appraiser_ata` is a
 * required, already-initialised account on the instruction, and the appraiser's wallet was created
 * minutes ago at their sign-in: it holds no token account for this mint and no SOL to open one
 * with. So the transaction opens it, in the same transaction, paid by whoever pays the fee — the
 * sponsor in a deployed build, the appraiser's own wallet on a local chain where they have SOL.
 * The program deliberately does NOT do this itself: `submit_verdict` is already the widest account
 * list in the program and was the SBF stack-frame overflow of S3 F1, so the client spends one
 * instruction instead of the money path spending stack. Idempotent, so a retry — or a second case
 * for the same mint — is safe.
 *
 * Forgetting it fails loudly at account validation (`AccountNotInitialized`) and moves nothing,
 * which is the failure mode §4 asks for.
 */
export async function submitVerdict(me: Me, l: LeaseView, deduction: number) {
  if (!Number.isSafeInteger(deduction) || deduction < 0) throw new Error("A verdict is a whole amount between nothing and the whole deposit.");
  if (deduction > l.deposit) throw new Error("A verdict cannot be more than the deposit the lease holds.");
  const lease = new PublicKey(l.address);
  const [tenant, landlord] = [new PublicKey(l.tenant), new PublicKey(l.landlord)];
  const [tokenProgramId, tenantAta, landlordAta, appraiserAta, payer] = await Promise.all([
    tokenProgram(),
    tokenAccountFor(tenant),
    tokenAccountFor(landlord),
    tokenAccountFor(me.key),
    SPONSORED ? sponsorFeePayer().then((f) => new PublicKey(f)) : Promise.resolve(me.key),
  ]);
  return send(me, me.program.methods
    .submitVerdict(new BN(deduction))
    .preInstructions([createAssociatedTokenAccountIdempotentInstruction(payer, appraiserAta, me.key, mint, tokenProgramId)])
    .accountsPartial({
      appraiser: me.key,
      lease,
      dispute: disputePda(lease),
      mint,
      vault: vaultPda(lease),
      tenant,
      tenantAta,
      landlordAta,
      appraiserAta,
      tenantProfile: profilePda(tenant),
      landlordProfile: profilePda(landlord),
      tokenProgram: tokenProgramId,
    }));
}

/**
 * A negotiated settlement needs BOTH the tenant's and the landlord's signature on one transaction.
 * The app's single-session model cannot collect two, so there is deliberately no button for this:
 * it is a script / multisig flow for now. This builds the unsigned transaction (fee payer = `me`),
 * which the first party signs, passes to the second, and sends.
 *
 * Since D2 it accepts `Mediation` as well as `Disputed`, and the `Dispute` account is an optional
 * account that must match the state exactly: the PDA in `Mediation` (`DisputeAccountRequired`),
 * and an explicit null in `Disputed` (`UnexpectedDisputeAccount`). Leaving it out is not the same
 * as null — Anchor would derive the PDA from the seeds and send it either way.
 */
export async function settleDisputeTx(me: Me, l: LeaseView, deduction: number) {
  const lease = new PublicKey(l.address);
  const [tenant, landlord] = [new PublicKey(l.tenant), new PublicKey(l.landlord)];
  const [tokenProgramId, tenantAta, landlordAta] = await Promise.all([tokenProgram(), tokenAccountFor(tenant), tokenAccountFor(landlord)]);
  return me.program.methods
    .settleDispute(new BN(deduction))
    .accountsPartial({
      tenant,
      landlord,
      lease,
      dispute: l.status === "mediation" ? disputePda(lease) : null,
      mint,
      vault: vaultPda(lease),
      tenantAta,
      landlordAta,
      tenantProfile: profilePda(tenant),
      landlordProfile: profilePda(landlord),
      tokenProgram: tokenProgramId,
    })
    .transaction();
}

/** The landlord closes a dispute the tenant left unanswered past the window. */
export async function finalizeDeduction(me: Me, l: LeaseView) {
  const lease = new PublicKey(l.address);
  const tenant = new PublicKey(l.tenant);
  const [tokenProgramId, tenantAta, landlordAta] = await Promise.all([tokenProgram(), tokenAccountFor(tenant), tokenAccountFor(me.key)]);
  return send(me, me.program.methods
    .finalizeDeduction()
    .accountsPartial({
      landlord: me.key,
      lease,
      mint,
      vault: vaultPda(lease),
      tenantAta,
      landlordAta,
      tenantProfile: profilePda(tenant),
      landlordProfile: profilePda(me.key),
      tokenProgram: tokenProgramId,
    }));
}

/** Surfpool cheatcode: jump the chain clock forward (local network only). */
export async function fastForward(secondsAhead: number) {
  const now = await loadNow();
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "surfnet_timeTravel",
      params: [{ absoluteTimestamp: (now + Math.ceil(secondsAhead)) * 1000 }],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message ?? "time travel failed");
}

export const explorerTx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=` +
  (/devnet/.test(RPC) ? "devnet" : `custom&customUrl=${encodeURIComponent(RPC)}`);

/**
 * What a person should read for the program errors they can actually run into. Others fall back to
 * the IDL's own message, which is written for a developer.
 *
 * Exported so a test can tell "has a friendly override" from "falls back" without re-listing the
 * keys next to this map, where the two copies would drift.
 */
export const FRIENDLY_PROGRAM_ERRORS: Record<string, string> = {
  KycRequired: "Verify your identity first: open the Verify tab, then come back.",
  WrongStatus: "That lease is not in a state where this can be done.",
  TooEarly: "This rent period is not due yet.",
  TermCompleted: "Every rent period of this lease is already paid.",
  SelfLease: "You cannot rent your own listing: landlord and tenant must be different wallets.",
  MintNotAllowed: "This listing uses a token that is not allowed for leases.",
  MissingConfidentialTransfer: "The private payment was assembled in the wrong order and was refused. Nothing was paid.",
  // Mediation (docs/contracts/dispute-mediation.md §9, errors 6038-6061). Each of these is
  // reachable by a person pressing a button on a lease someone else changed a moment earlier, so
  // each says what to do rather than naming the rule it broke. Nobody reading these knows what a
  // PDA, a window or a key proposal is.
  DisputeRoundsExhausted: "You have already proposed a deduction twice and the tenant rejected both. You can still return the deposit in full.",
  WrongDisputeRound: "This lease has moved to another round since the screen was loaded. Reload it and look again.",
  NotMediationParty: "Only this lease's landlord or tenant can do that — or, for the appraiser's account, it must be somebody other than the two of you.",
  AppraiserAlreadyBound: "An appraiser is already confirmed for this lease, so the choosing is finished. They have a window to answer and then either side can end the mediation.",
  AppraiserNotBound: "No appraiser has been confirmed for this lease yet, so there is nobody entitled to decide it.",
  NotBoundAppraiser: "Only the appraiser both sides confirmed can decide this lease.",
  CandidatesAlreadyProposed: "You have already named your companies, and each side names them once. You can still pick from either list.",
  DuplicateCandidate: "The same company is in your list twice. Names are compared ignoring capitals and spacing.",
  CandidateNotProposed: "Neither side named that company. Pick one of the names shown, spelled the same way.",
  SelectionWindowOpen: "There is still time for the two of you to agree on an appraiser, so the mediation cannot be ended yet.",
  VerdictWindowOpen: "The appraiser still has time to answer. You can end the mediation once that time runs out.",
  VerdictWindowClosed: "The time to answer has passed, so no verdict can be accepted. Either side can now end the mediation.",
  DisputeAccountRequired: "This lease is in mediation, so settling it needs its mediation record. Reload the screen and try again.",
  UnexpectedDisputeAccount: "This lease is not in mediation. Reload the screen and try again.",
  SelectionWindowClosed: "The time to agree on an appraiser has run out. Either side can now end the mediation, and the deposit goes back to the tenant.",
  InvalidAppraiserName:
    "That company name cannot be used: it has to be 1 to 64 characters with nothing invisible in it. Type it by hand rather than pasting it.",
  NoCandidates: `Name between one and ${MAX_CANDIDATES} companies.`,
  FeeAboveCap: "That fee is more than a tenth of the deposit, which is the most an appraiser can be paid out of it. Quote less.",
  NameAlreadyAgreed: "The two of you have already agreed on a company. The next step is the appraiser's own account.",
  NameNotAgreed: "You have not agreed on a company yet. Both sides have to pick the same one first.",
  InvalidAppraiserKey: "That is the all-zero address, which nobody holds. Use the account the appraiser signed in with.",
  KeyProposalsExhausted:
    "You have used both of your attempts at the appraiser's account. The other side can still confirm the last one, or put forward one of their own.",
  NoKeyProposed: "Nobody has put the appraiser's account forward yet, so there is nothing to confirm.",
  CannotConfirmOwnProposal: "You put this account forward, so the other side is the one who confirms it. That is what stops either of you choosing the appraiser alone.",
  KeyMismatch: "The account on this screen is not the one that was put forward — it changed a moment ago. Reload and look at it again before confirming.",
};

/** Finds the program error named, or coded, anywhere in a failure's text (message, logs, simulation error). */
export function programErrorMessage(text: string): string | null {
  const errors = (idl as { errors?: { name: string; code: number; msg?: string }[] }).errors ?? [];
  for (const er of errors) {
    const hex = `0x${er.code.toString(16)}`;
    if (
      new RegExp(`\\b${er.name}\\b`).test(text) ||
      text.toLowerCase().includes(`custom program error: ${hex}`) ||
      new RegExp(`"Custom"\\s*:\\s*${er.code}\\b`).test(text)
    )
      return FRIENDLY_PROGRAM_ERRORS[er.name] ?? er.msg ?? null;
  }
  return null;
}

export function errorMessage(e: unknown): string {
  const err = e as {
    error?: { errorMessage?: string };
    message?: string;
    name?: string;
    simulationResponse?: { err: unknown; logs?: string[] | null };
  };
  const sim = err?.simulationResponse;
  const known = programErrorMessage([err?.message, err?.error?.errorMessage, ...(sim?.logs ?? []), sim ? jsonSafe(sim.err) : ""].filter(Boolean).join(" "));
  if (known) return known;
  if (isShortPublicBalance([err?.message, ...(sim?.logs ?? []), sim ? jsonSafe(sim.err) : ""].filter(Boolean).join(" ")))
    return "Not enough public balance for the deposit. Add funds and keep part of it public.";
  // System program "custom program error: 0x1" is InsufficientFunds: the wallet cannot pay the rent
  // of the account this action creates (the sponsor covers fees, not account storage).
  if (/11111111111111111111111111111111 failed: custom program error: 0x1\b/.test([err?.message, ...(sim?.logs ?? [])].filter(Boolean).join(" ")))
    return "This wallet has too little SOL to cover the storage rent of the account this creates. The sponsor pays fees but not rent; send the wallet a little devnet SOL and try again.";
  if (err?.error?.errorMessage) return err.error.errorMessage;
  if (sim) {
    const why = jsonSafe(sim.err);
    if (/AccountNotFound/.test(why)) return "This wallet has no SOL on this network, so it cannot pay fees. Fund it first (see the box at the top).";
    return `The network rejected the transaction: ${why}${sim.logs?.length ? `. Last log: ${sim.logs[sim.logs.length - 1]}` : ""}`;
  }
  if (SPONSORED && /fetch|network|load failed/i.test(err?.message ?? ""))
    return `Could not reach the sponsoring backend at ${API}. Is it running?`;
  if (err?.name?.startsWith("Wallet"))
    return `${err.message || "The wallet did not sign"} (${err.name}). Check that the wallet is unlocked, set to the same network as this app (${RPC}), and that its active account is the one connected here.`;
  return err?.message ?? "Something went wrong";
}
