import * as anchor from "@anchor-lang/core";
import { AnchorProvider, BN, Program } from "@anchor-lang/core";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import idl from "@target/idl/relstate.json";
import type { Relstate } from "@target/types/relstate";
import { GRACE_SECS, MINT, PERIOD_SECS, RPC, TERM_PERIODS } from "./config";

const { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } = anchor.web3;
type PubKey = anchor.web3.PublicKey;

export type Role = "landlord" | "tenant";
export type Status = "proposed" | "active" | "closed" | "defaulted";

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

export const isWallet = (s: string) => {
  try {
    return new PublicKey(s).toBytes().length === 32;
  } catch {
    return false;
  }
};

export const connection = new Connection(RPC, "confirmed");
const mint = new PublicKey(MINT);

interface WalletLike {
  publicKey: PubKey;
  signTransaction: <T extends anchor.web3.Transaction | anchor.web3.VersionedTransaction>(tx: T) => Promise<T>;
  signAllTransactions: <T extends anchor.web3.Transaction | anchor.web3.VersionedTransaction>(txs: T[]) => Promise<T[]>;
}

export interface Me {
  key: PubKey;
  ata: PubKey;
  program: Program<Relstate>;
}

const tokenAccount = (wallet: PubKey) => getAssociatedTokenAddressSync(mint, wallet);

export function makeMe(wallet: WalletLike): Me {
  const provider = new AnchorProvider(connection, wallet as never, { commitment: "confirmed" });
  return { key: wallet.publicKey, ata: tokenAccount(wallet.publicKey), program: new Program<Relstate>(idl as Relstate, provider) };
}

const reader = new Program<Relstate>(
  idl as Relstate,
  new AnchorProvider(
    connection,
    { publicKey: PublicKey.default, signTransaction: async (t: unknown) => t, signAllTransactions: async (t: unknown) => t } as never,
    { commitment: "confirmed" },
  ),
);
const programId = reader.programId;

const u64 = (n: BN) => n.toArrayLike(Buffer, "le", 8);
const pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const leasePda = (landlord: PubKey, id: string) => pda(Buffer.from("lease"), landlord.toBuffer(), u64(new BN(id)));
const listingPda = (landlord: PubKey, id: string) => pda(Buffer.from("listing"), landlord.toBuffer(), u64(new BN(id)));
const vaultPda = (lease: PubKey) => pda(Buffer.from("vault"), lease.toBuffer());
const profilePda = (wallet: PubKey) => pda(Buffer.from("profile"), wallet.toBuffer());
const applicationPda = (listing: PubKey, tenant: PubKey) => pda(Buffer.from("application"), listing.toBuffer(), tenant.toBuffer());

export const leaseAddress = (landlord: string, id: string) => leasePda(new PublicKey(landlord), id).toBase58();
export const newId = () => String(Date.now());


type Acc<K extends "lease" | "profile" | "listing" | "application"> = NonNullable<Awaited<ReturnType<(typeof reader.account)[K]["fetchNullable"]>>>;

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
  };

const applicationView = (address: PubKey, a: Acc<"application">): ApplicationView => ({
  address: address.toBase58(),
  listing: a.listing.toBase58(),
  landlord: a.landlord.toBase58(),
  tenant: a.tenant.toBase58(),
});

const newestFirst = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => Number(b.id) - Number(a.id));

export async function loadListings(): Promise<ListingView[]> {
  return newestFirst((await reader.account.listing.all()).map((r) => listingView(r.publicKey, r.account)));
}

// Key offsets in an application: landlord 40, tenant 72. Applications for a landlord's listings, or made by a tenant.
export async function loadApplications(who: { landlord: string } | { tenant: string }): Promise<ApplicationView[]> {
  const [offset, wallet] = "landlord" in who ? [40, who.landlord] : [72, who.tenant];
  const rows = await reader.account.application.all([{ memcmp: { offset, bytes: new PublicKey(wallet).toBase58() } }]);
  return rows.map((r) => applicationView(r.publicKey, r.account));
}

export async function loadLeases(wallet: string, role: Role): Promise<LeaseView[]> {
  const bytes = new PublicKey(wallet).toBase58();
  const rows = await reader.account.lease.all([{ memcmp: { offset: role === "landlord" ? 8 : 40, bytes } }]);
  return newestFirst(rows.map((r) => leaseView(r.publicKey, r.account)));
}

export async function loadProfile(address: string): Promise<ProfileView | null> {
  return profileView(await reader.account.profile.fetchNullable(profilePda(new PublicKey(address))));
}

export async function loadNow(): Promise<number> {
  const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  return clock ? Number(clock.data.readBigInt64LE(32)) : Math.floor(Date.now() / 1000);
}

export async function loadBalances(wallet: string): Promise<{ sol: number; usdc: number | null }> {
  const key = new PublicKey(wallet);
  const [lamports, usdc] = await Promise.all([
    connection.getBalance(key),
    getAccount(connection, tokenAccount(key)).then(
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

export function createListing(me: Me, id: string, f: NewListing) {
  return me.program.methods
    .createListing(new BN(id), new BN(f.rent), new BN(f.deposit), Array.from(f.region, (c) => c.charCodeAt(0)), f.title, f.city, f.blurb, f.photo)
    .accountsPartial({ landlord: me.key, listing: listingPda(me.key, id) })
    .rpc();
}

export function closeListing(me: Me, l: ListingView) {
  return me.program.methods
    .closeListing()
    .accountsPartial({ landlord: me.key, listing: new PublicKey(l.address) })
    .rpc();
}

export function applyTo(me: Me, l: ListingView) {
  const listing = new PublicKey(l.address);
  return me.program.methods
    .apply()
    .accountsPartial({ tenant: me.key, listing, application: applicationPda(listing, me.key) })
    .rpc();
}

const closeApplicationCall = (me: Me, a: ApplicationView) =>
  me.program.methods
    .closeApplication()
    .accountsPartial({ signer: me.key, application: new PublicKey(a.address), tenant: new PublicKey(a.tenant) });

// Either the applicant (withdraw) or the landlord (dismiss).
export function closeApplication(me: Me, a: ApplicationView) {
  return closeApplicationCall(me, a).rpc();
}

// When the tenant had applied, the application is closed in the same transaction.
export async function proposeLease(me: Me, id: string, l: ListingView, tenant: string, hash: number[], application?: ApplicationView) {
  const tenantKey = new PublicKey(tenant);
  const lease = leasePda(me.key, id);
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
    });
  return application ? call.postInstructions([await closeApplicationCall(me, application).instruction()]).rpc() : call.rpc();
}

export function fundDeposit(me: Me, l: LeaseView, hash: number[]) {
  const lease = new PublicKey(l.address);
  return me.program.methods
    .fundDeposit(hash)
    .accountsPartial({
      tenant: me.key,
      lease,
      mint,
      vault: vaultPda(lease),
      tenantAta: me.ata,
      tenantProfile: profilePda(me.key),
    })
    .rpc();
}

export function payRent(me: Me, l: LeaseView) {
  return me.program.methods
    .payRent()
    .accountsPartial({
      tenant: me.key,
      lease: new PublicKey(l.address),
      mint,
      tenantAta: me.ata,
      landlordAta: tokenAccount(new PublicKey(l.landlord)),
      tenantProfile: profilePda(me.key),
    })
    .rpc();
}

export function releaseDeposit(me: Me, l: LeaseView, deduction: number) {
  const lease = new PublicKey(l.address);
  const tenant = new PublicKey(l.tenant);
  return me.program.methods
    .releaseDeposit(new BN(deduction))
    .accountsPartial({
      landlord: me.key,
      lease,
      mint,
      vault: vaultPda(lease),
      tenantAta: tokenAccount(tenant),
      landlordAta: me.ata,
      tenantProfile: profilePda(tenant),
      landlordProfile: profilePda(me.key),
    })
    .rpc();
}

export function markDefault(me: Me, l: LeaseView) {
  const lease = new PublicKey(l.address);
  const tenant = new PublicKey(l.tenant);
  return me.program.methods
    .markDefault()
    .accountsPartial({
      landlord: me.key,
      lease,
      mint,
      vault: vaultPda(lease),
      tenantAta: tokenAccount(tenant),
      landlordAta: me.ata,
      tenantProfile: profilePda(tenant),
    })
    .rpc();
}

export function claimDeposit(me: Me, l: LeaseView) {
  const lease = new PublicKey(l.address);
  const landlord = new PublicKey(l.landlord);
  return me.program.methods
    .claimDeposit()
    .accountsPartial({
      tenant: me.key,
      lease,
      mint,
      vault: vaultPda(lease),
      tenantAta: me.ata,
      landlordAta: tokenAccount(landlord),
      tenantProfile: profilePda(me.key),
      landlordProfile: profilePda(landlord),
    })
    .rpc();
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

export function errorMessage(e: unknown): string {
  const err = e as { error?: { errorMessage?: string }; message?: string };
  return err?.error?.errorMessage ?? err?.message ?? "Something went wrong";
}
