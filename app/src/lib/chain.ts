import * as anchor from "@anchor-lang/core";
import { AnchorProvider, BN, Program } from "@anchor-lang/core";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import idl from "@target/idl/relstate.json";
import type { Relstate } from "@target/types/relstate";
import demo from "@/demo.json";
import { GRACE_SECS, MINT, PERIOD_SECS, RPC, TERM_PERIODS } from "./config";

const { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } = anchor.web3;
type PubKey = anchor.web3.PublicKey;

export type Role = "landlord" | "tenant";
export type Status = "proposed" | "active" | "closed" | "defaulted";

export interface LeaseView {
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
}

export interface Snapshot {
  lease: LeaseView | null;
  profiles: Record<Role, ProfileView | null>;
  balances: Record<Role, number>;
  now: number; // chain clock, unix seconds
}

const connection = new Connection(RPC, "confirmed");
const mint = new PublicKey(MINT);

function makeActor(secret: number[]) {
  const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
  // NodeWallet isn't available in the browser bundle, so sign with the keypair directly
  const sign = <T extends anchor.web3.Transaction | anchor.web3.VersionedTransaction>(tx: T): T => {
    if ("version" in tx) tx.sign([kp]);
    else tx.partialSign(kp);
    return tx;
  };
  const wallet = {
    publicKey: kp.publicKey,
    signTransaction: async <T extends anchor.web3.Transaction | anchor.web3.VersionedTransaction>(tx: T) => sign(tx),
    signAllTransactions: async <T extends anchor.web3.Transaction | anchor.web3.VersionedTransaction>(txs: T[]) =>
      txs.map(sign),
  };
  const provider = new AnchorProvider(connection, wallet as never, { commitment: "confirmed" });
  return {
    key: kp.publicKey,
    ata: getAssociatedTokenAddressSync(mint, kp.publicKey),
    program: new Program<Relstate>(idl as Relstate, provider),
  };
}

export const actors: Record<Role, ReturnType<typeof makeActor>> = {
  landlord: makeActor(demo.landlord),
  tenant: makeActor(demo.tenant),
};

const programId = actors.landlord.program.programId;
const u64 = (n: BN) => n.toArrayLike(Buffer, "le", 8);
const leasePda = (landlord: PubKey, id: BN) =>
  PublicKey.findProgramAddressSync([Buffer.from("lease"), landlord.toBuffer(), u64(id)], programId)[0];
const vaultPda = (lease: PubKey) => PublicKey.findProgramAddressSync([Buffer.from("vault"), lease.toBuffer()], programId)[0];
const profilePda = (wallet: PubKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("profile"), wallet.toBuffer()], programId)[0];

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

export const newLeaseId = () => String(Date.now());

const profileView = (
  p: Awaited<ReturnType<typeof actors.landlord.program.account.profile.fetchNullable>>,
): ProfileView | null =>
  p && {
    leasesCompleted: p.leasesCompleted,
    paidOnTime: p.paidOnTime,
    paidLate: p.paidLate,
    defaults: p.defaults,
    depositsReturnedFull: p.depositsReturnedFull,
    depositsClaimed: p.depositsClaimed,
    depositTotal: p.depositTotal.toNumber(),
    deductedTotal: p.deductedTotal.toNumber(),
  };

/** On-chain record of any wallet; null if it never took part in a lease. Throws on a malformed address. */
export async function loadProfile(address: string): Promise<ProfileView | null> {
  const wallet = new PublicKey(address);
  return profileView(await actors.landlord.program.account.profile.fetchNullable(profilePda(wallet)));
}

/** Everything the UI needs, read in one go. */
export async function loadSnapshot(leaseId: string | null): Promise<Snapshot> {
  const { landlord, tenant } = actors;
  const program = landlord.program;

  const [clock, l, t, lease, landlordBal, tenantBal] = await Promise.all([
    connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY),
    program.account.profile.fetchNullable(profilePda(landlord.key)),
    program.account.profile.fetchNullable(profilePda(tenant.key)),
    leaseId ? program.account.lease.fetchNullable(leasePda(landlord.key, new BN(leaseId))) : null,
    balanceOf(landlord.ata),
    balanceOf(tenant.ata),
  ]);

  return {
    lease:
      lease && leaseId
        ? {
            id: leaseId,
            landlord: lease.landlord.toBase58(),
            tenant: lease.tenant.toBase58(),
            rent: lease.rentAmount.toNumber(),
            deposit: lease.depositAmount.toNumber(),
            startTs: lease.startTs.toNumber(),
            termPeriods: lease.termPeriods,
            paidCount: lease.paidCount,
            periodSecs: lease.periodSecs.toNumber(),
            graceSecs: lease.graceSecs.toNumber(),
            hashHex: hex(lease.leaseHash),
            region: String.fromCharCode(...lease.region),
            status: Object.keys(lease.status)[0] as Status,
          }
        : null,
    profiles: { landlord: profileView(l), tenant: profileView(t) },
    balances: { landlord: landlordBal, tenant: tenantBal },
    now: clock ? Number(clock.data.readBigInt64LE(32)) : Math.floor(Date.now() / 1000),
  };
}

async function balanceOf(ata: PubKey) {
  try {
    return Number((await getAccount(connection, ata)).amount);
  } catch {
    return 0;
  }
}

// ---- instructions (each returns the transaction signature) -------------------------------

export function createLease(id: string, rent: number, deposit: number, hash: number[], region: string) {
  const { landlord, tenant } = actors;
  const lease = leasePda(landlord.key, new BN(id));
  return landlord.program.methods
    .createLease(new BN(id), new BN(rent), new BN(deposit), new BN(PERIOD_SECS), new BN(GRACE_SECS), TERM_PERIODS, hash, Array.from(region, (c) => c.charCodeAt(0)))
    .accountsPartial({
      landlord: landlord.key,
      tenant: tenant.key,
      mint,
      lease,
      vault: vaultPda(lease),
      landlordProfile: profilePda(landlord.key),
    })
    .rpc();
}

export function fundDeposit(id: string, hash: number[]) {
  const { landlord, tenant } = actors;
  const lease = leasePda(landlord.key, new BN(id));
  return tenant.program.methods
    .fundDeposit(hash)
    .accountsPartial({
      tenant: tenant.key,
      lease,
      mint,
      vault: vaultPda(lease),
      tenantAta: tenant.ata,
      tenantProfile: profilePda(tenant.key),
    })
    .rpc();
}

export function payRent(id: string) {
  const { landlord, tenant } = actors;
  return tenant.program.methods
    .payRent()
    .accountsPartial({
      tenant: tenant.key,
      lease: leasePda(landlord.key, new BN(id)),
      mint,
      tenantAta: tenant.ata,
      landlordAta: landlord.ata,
      tenantProfile: profilePda(tenant.key),
    })
    .rpc();
}

export function releaseDeposit(id: string, deduction: number) {
  const { landlord, tenant } = actors;
  const lease = leasePda(landlord.key, new BN(id));
  return landlord.program.methods
    .releaseDeposit(new BN(deduction))
    .accountsPartial({
      landlord: landlord.key,
      lease,
      mint,
      vault: vaultPda(lease),
      tenantAta: tenant.ata,
      landlordAta: landlord.ata,
      tenantProfile: profilePda(tenant.key),
      landlordProfile: profilePda(landlord.key),
    })
    .rpc();
}

export function markDefault(id: string) {
  const { landlord, tenant } = actors;
  const lease = leasePda(landlord.key, new BN(id));
  return landlord.program.methods
    .markDefault()
    .accountsPartial({
      landlord: landlord.key,
      lease,
      mint,
      vault: vaultPda(lease),
      tenantAta: tenant.ata,
      landlordAta: landlord.ata,
      tenantProfile: profilePda(tenant.key),
    })
    .rpc();
}

export function claimDeposit(id: string) {
  const { landlord, tenant } = actors;
  const lease = leasePda(landlord.key, new BN(id));
  return tenant.program.methods
    .claimDeposit()
    .accountsPartial({
      tenant: tenant.key,
      lease,
      mint,
      vault: vaultPda(lease),
      tenantAta: tenant.ata,
      landlordAta: landlord.ata,
      tenantProfile: profilePda(tenant.key),
      landlordProfile: profilePda(landlord.key),
    })
    .rpc();
}

/** Surfpool cheatcode: jump the chain clock forward (local demo only). */
export async function fastForward(secondsAhead: number) {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  const now = Number(info!.data.readBigInt64LE(32));
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
