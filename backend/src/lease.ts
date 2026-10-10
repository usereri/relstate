// Reading a `Lease` account without Anchor.
//
// The backend has no Anchor client and no IDL — it is a plain kit/Node service — but the auditor
// check needs one number off the chain: `rent_amount`, the figure a confidential payment is
// supposed to have settled. So the account is decoded by hand from the layout in
// `programs/relstate/src/state.rs`.
//
// Hand-written offsets rot silently, which is why `decodeLease` refuses anything that is not
// exactly the size Anchor allocates for this struct. A field added to `Lease` changes that size, so
// the mismatch surfaces here, at the first request, naming the account — not as a plausible-looking
// wrong amount in a compliance answer.
import { getAddressDecoder, getBase64Encoder, type Address, type GetAccountInfoApi, type Rpc } from "@solana/kit";

/**
 * `8 + Lease::INIT_SPACE`: discriminator, landlord, tenant, mint, lease_id, rent_amount,
 * deposit_amount, start_ts, term_periods, paid_count, lease_hash, status, bump, period_secs,
 * grace_secs, region, discount_pct.
 */
export const LEASE_ACCOUNT_SIZE = 193;

/** Byte offset of every field this module reads. Anchor packs the struct with no padding. */
const AT = {
  landlord: 8,
  tenant: 40,
  mint: 72,
  leaseId: 104,
  rentAmount: 112,
  depositAmount: 120,
  startTs: 128,
  termPeriods: 136,
  paidCount: 138,
  status: 172,
} as const;

export const LEASE_STATUS = ["proposed", "active", "closed", "defaulted"] as const;
export type LeaseStatus = (typeof LEASE_STATUS)[number];

export type DecodedLease = {
  landlord: Address;
  tenant: Address;
  mint: Address;
  leaseId: bigint;
  /** What rent is contracted to be. The one figure the auditor check compares against. */
  rentAmount: bigint;
  depositAmount: bigint;
  startTs: bigint;
  termPeriods: number;
  paidCount: number;
  status: LeaseStatus;
};

export class LeaseDecodeError extends Error {}
export class LeaseNotFound extends Error {}

/**
 * Reads one lease off the chain.
 *
 * The owner check is the authorisation that matters: an attacker who could point this at an account
 * they control could name any `rentAmount` and make a wrong payment verify. Only the program may
 * own a lease, so only the program can have written the figure we compare against.
 */
export async function fetchLease(rpc: Rpc<GetAccountInfoApi>, lease: Address, program: Address): Promise<DecodedLease> {
  const { value } = await rpc.getAccountInfo(lease, { encoding: "base64", commitment: "confirmed" }).send();
  if (value === null) throw new LeaseNotFound(`no account at ${lease}`);
  if (value.owner !== program) throw new LeaseNotFound(`${lease} is not a ${program} account`);
  return decodeLease(new Uint8Array(getBase64Encoder().encode(value.data[0])));
}

export function decodeLease(data: Uint8Array): DecodedLease {
  if (data.length !== LEASE_ACCOUNT_SIZE) {
    throw new LeaseDecodeError(
      `expected a ${LEASE_ACCOUNT_SIZE}-byte lease account, got ${data.length} bytes. ` +
        "If the Lease struct changed, backend/src/lease.ts has to change with it.",
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decodeAddress = getAddressDecoder();
  const address = (offset: number): Address => decodeAddress.decode(data.subarray(offset, offset + 32));
  const status = LEASE_STATUS[data[AT.status]!];
  if (status === undefined) throw new LeaseDecodeError(`unknown lease status byte ${data[AT.status]}`);
  return {
    landlord: address(AT.landlord),
    tenant: address(AT.tenant),
    mint: address(AT.mint),
    leaseId: view.getBigUint64(AT.leaseId, true),
    rentAmount: view.getBigUint64(AT.rentAmount, true),
    depositAmount: view.getBigUint64(AT.depositAmount, true),
    startTs: view.getBigInt64(AT.startTs, true),
    termPeriods: view.getUint16(AT.termPeriods, true),
    paidCount: view.getUint16(AT.paidCount, true),
    status,
  };
}
