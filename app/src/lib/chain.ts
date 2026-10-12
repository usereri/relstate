import * as anchor from "@anchor-lang/core";
import { AnchorProvider, BN, Program } from "@anchor-lang/core";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import idl from "@target/idl/relstate.json";
import type { Relstate } from "@target/types/relstate";
import { GRACE_SECS, IS_LOCAL, MINT, PERIOD_SECS, RPC, TERM_PERIODS } from "./config";
import { retryingFetch } from "./rpc";
import { invalidateReads, sharedRead } from "./reads";
import { isShortPublicBalance } from "./holdback";
import { MAX_CANDIDATES, setKey } from "./mediation";
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

/**
 * The `Dispute` PDA, which exists exactly while a lease is in `Mediation`
 * (docs/contracts/dispute-mediation.md §3).
 *
 * Unset pubkeys arrive as `""` rather than the program's all-zero marker, and each candidate list
 * is already cut to the count the account records, so `[..count]` padding never reaches a screen.
 */
export interface DisputeView {
  address: string;
  lease: string;
  landlordCandidates: string[];
  tenantCandidates: string[];
  /** "" until that side picks; a side may change its pick while nothing is bound */
  landlordPick: string;
  tenantPick: string;
  /** "" until both picks match, or the default is bound */
  appraiser: string;
  /** unix seconds; past it anyone may bind the registry's default appraiser */
  selectionDeadline: number;
  /** unix seconds; past it no verdict can land and either party may end the mediation */
  verdictDeadline: number;
}

/** One entry of the on-chain appraiser registry, maintained by the Config admin. */
export interface AppraiserView {
  /** the `Appraiser` PDA, which is what the instructions take */
  address: string;
  wallet: string;
  active: boolean;
  isDefault: boolean;
  /** base units of the lease mint, capped per lease at `deposit / APPRAISER_FEE_CAP_DIVISOR` */
  fee: number;
  /** sha256 of the company's name: the commitment the off-chain directory is checked against */
  nameHashHex: string;
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
/** How long the bound appraiser has to submit a verdict. Demo 60 s, release 14 days. */
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
/**
 * The registry entry for a wallet. Seeded on the appraiser's own key, so — unlike every other
 * account here — Anchor cannot derive it: the seed is a field of the account being resolved. Every
 * mediation instruction that names an appraiser therefore gets this passed in
 * (docs/contracts/dispute-mediation.md §4).
 */
const appraiserPda = (wallet: PubKey) => pda(Buffer.from("appraiser"), wallet.toBuffer());

export const leaseAddress = (landlord: string, id: string) => leasePda(new PublicKey(landlord), id).toBase58();
export const newId = () => String(Date.now());


type Acc<K extends "lease" | "profile" | "listing" | "application" | "dispute" | "appraiser"> = NonNullable<Awaited<ReturnType<(typeof reader.account)[K]["fetchNullable"]>>>;

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
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

const disputeView = (address: PubKey, d: Acc<"dispute">): DisputeView => ({
  address: address.toBase58(),
  lease: d.lease.toBase58(),
  landlordCandidates: d.landlordCandidates.slice(0, d.landlordCount).map((k) => k.toBase58()),
  tenantCandidates: d.tenantCandidates.slice(0, d.tenantCount).map((k) => k.toBase58()),
  landlordPick: setKey(d.landlordPick.toBase58()),
  tenantPick: setKey(d.tenantPick.toBase58()),
  appraiser: setKey(d.appraiser.toBase58()),
  selectionDeadline: d.selectionDeadline.toNumber(),
  verdictDeadline: d.verdictDeadline.toNumber(),
});

const appraiserView = (address: PubKey, a: Acc<"appraiser">): AppraiserView => ({
  address: address.toBase58(),
  wallet: a.wallet.toBase58(),
  active: a.active,
  isDefault: a.isDefault,
  fee: a.fee.toNumber(),
  nameHashHex: hex(a.nameHash),
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
 * One lease by address, for the operator console: it is handed a lease nobody's wallet is a party
 * to, so it cannot find it through {@link loadLeases}, which scans by landlord or tenant.
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

/**
 * The whole appraiser registry.
 *
 * There is no on-chain index of it — that is the reason the program cannot enforce a single
 * default (§4) — so this is a discriminator scan, read only while a Mediation screen is open and
 * shared for a tick like every other scan.
 */
export function loadAppraisers(): Promise<AppraiserView[]> {
  return sharedRead("appraisers", async () => (await reader.account.appraiser.all()).map((r) => appraiserView(r.publicKey, r.account)));
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

/**
 * Contract 2: hand a transaction to the backend, which pays the fee and submits it, so the
 * user never needs SOL.
 *
 * The fee payer's address is part of what the user signs, so it is filled in here and only its
 * signature slot is left empty — that is what "fee payer empty" means on the wire.
 */
export async function sendSponsored(me: Me, tx: anchor.web3.Transaction): Promise<string> {
  const [feePayer, latest] = await Promise.all([sponsorFeePayer(), connection.getLatestBlockhash("confirmed")]);
  tx.feePayer = new PublicKey(feePayer);
  tx.recentBlockhash = latest.blockhash;
  tx.lastValidBlockHeight = latest.lastValidBlockHeight;
  const signed = await me.wallet.signTransaction(tx);
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
export async function proposeLease(me: Me, id: string, l: ListingView, tenant: string, hash: number[], application?: ApplicationView) {
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
      TERM_PERIODS,
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

/**
 * One side names up to three registered, active appraisers, once.
 *
 * The candidates are the `Appraiser` accounts themselves, not pubkey arguments: Anchor's seed and
 * discriminator checks then *are* the registry lookup, so there is no path on which an
 * unregistered or suspended key reaches a candidate list (§4). The unused slots are optional
 * accounts and must be passed as explicit nulls, or Anchor would derive and send them.
 */
export function proposeAppraisers(me: Me, l: LeaseView, wallets: string[]) {
  // Said here rather than left to the destructure below, which would have sent `appraiser_one:
  // undefined` for an empty list (Anchor then tries to derive a PDA whose seed is a field of the
  // account it is deriving, and fails with something unrelated) and silently dropped a fourth.
  // Dropping one is the worse of the two: the side would have proposed something other than what
  // it chose, and a side only proposes once.
  if (wallets.length === 0) throw new Error("Choose at least one appraiser to put forward.");
  if (wallets.length > MAX_CANDIDATES)
    throw new Error(`A side may put forward at most ${MAX_CANDIDATES} appraisers, and ${wallets.length} were chosen.`);
  if (new Set(wallets).size !== wallets.length) throw new Error("Each appraiser can only be put forward once.");
  const lease = new PublicKey(l.address);
  const [one, two, three] = wallets.map((w) => appraiserPda(new PublicKey(w)));
  return send(me, me.program.methods
    .proposeAppraisers()
    .accountsPartial({
      party: me.key,
      lease,
      dispute: disputePda(lease),
      appraiserOne: one,
      appraiserTwo: two ?? null,
      appraiserThree: three ?? null,
    }));
}

/**
 * This side picks one appraiser from either list. The same pick from both sides binds it and
 * re-bases the verdict deadline on the binding; a side may change its pick until then.
 */
export function pickAppraiser(me: Me, l: LeaseView, wallet: string) {
  const lease = new PublicKey(l.address);
  return send(me, me.program.methods
    .pickAppraiser()
    .accountsPartial({ party: me.key, lease, dispute: disputePda(lease), appraiser: appraiserPda(new PublicKey(wallet)) }));
}

/**
 * The deadlock exit: after the selection deadline with nothing bound, **anyone** may bind the
 * registry's default appraiser. This is why a mediation the two sides never agree on cannot lock
 * the deposit.
 */
export function bindDefaultAppraiser(me: Me, l: LeaseView, wallet: string) {
  const lease = new PublicKey(l.address);
  return send(me, me.program.methods
    .bindDefaultAppraiser()
    .accountsPartial({ caller: me.key, lease, dispute: disputePda(lease), appraiser: appraiserPda(new PublicKey(wallet)) }));
}

/**
 * The appraiser stayed silent past their window: either party returns the lease to `Active` with
 * the claim clock resumed, and the tenant then takes the whole deposit through `claim_deposit`.
 * The `Dispute` account closes and its rent goes back to the tenant, which is why they are named.
 */
export function expireMediation(me: Me, l: LeaseView) {
  const lease = new PublicKey(l.address);
  return send(me, me.program.methods
    .expireMediation()
    .accountsPartial({ party: me.key, lease, dispute: disputePda(lease), tenant: new PublicKey(l.tenant) }));
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
  // Mediation (docs/contracts/dispute-mediation.md §9). Each of these is reachable by a person
  // pressing a button on a lease someone else changed a moment earlier, so each says what to do.
  DisputeRoundsExhausted: "You have already proposed a deduction twice and the tenant rejected both. You can still release the deposit in full.",
  WrongDisputeRound: "This lease has moved to another round since the screen was loaded. Reload it and look again.",
  NotMediationParty: "Only this lease's landlord or tenant can do that.",
  AppraiserInactive: "That appraiser is no longer taking cases. Choose another one from the list.",
  AppraiserNotDefault: "That appraiser is not the registry's fallback, so it cannot be bound on its own.",
  AppraiserAlreadyBound: "An appraiser has already been agreed for this lease, so the lists are closed.",
  AppraiserNotBound: "No appraiser has been agreed for this lease yet.",
  NotBoundAppraiser: "Only the appraiser both sides agreed on can decide this lease.",
  CandidatesAlreadyProposed: "You have already named your appraisers, and a side only names them once.",
  DuplicateCandidate: "Each appraiser can only be named once.",
  CandidateNotProposed: "That appraiser is on neither side's list. Choose one of the names shown.",
  SelectionWindowOpen: "There is still time to agree on an appraiser together. The fallback can only be used after that.",
  VerdictWindowOpen: "The appraiser still has time to decide. You can end the mediation once their window passes.",
  VerdictWindowClosed: "The appraiser's window has passed, so no verdict can land. Either side can now end the mediation.",
  BindingWindowClosed: "Too late to agree on an appraiser: the window has passed. Either side can now end the mediation and unlock the deposit.",
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
