// Reading a `Lease` account without Anchor.
//
// The backend has no Anchor client, but the auditor check needs one number off the chain:
// `rent_amount`, the figure a confidential payment is supposed to have settled. The byte offsets come
// from the program's own IDL (`layout.ts`), not from constants here: the Lease struct is going to
// change, and hand-copied offsets fail silently with a plausible wrong amount in a compliance answer.
//
// `decodeLease` still refuses any account that is not exactly the size the layout says, so a struct
// that changed under an old IDL fails loudly at the first request, naming the account.
import { getAddressDecoder, getBase64Encoder, type Address, type GetAccountInfoApi, type Rpc } from "@solana/kit";
import { FALLBACK_LAYOUTS, accountLayout, fieldOffset, type Layout } from "./layout.ts";

export const leaseLayout = (): Layout => accountLayout("Lease");
/** The snapshot size, for tests that build a buffer by hand. The live figure is `leaseLayout().size`. */
export const LEASE_ACCOUNT_SIZE = FALLBACK_LAYOUTS.Lease!.size;

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

export function decodeLease(data: Uint8Array, layout: Layout = leaseLayout()): DecodedLease {
  if (data.length !== layout.size) {
    throw new LeaseDecodeError(
      `expected a ${layout.size}-byte lease account, got ${data.length} bytes. ` +
        "The Lease struct changed: rebuild the program (target/idl) or update FALLBACK_LAYOUTS in backend/src/layout.ts.",
    );
  }
  const at = (field: string) => fieldOffset(layout, "Lease", field);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decodeAddress = getAddressDecoder();
  const address = (field: string): Address => decodeAddress.decode(data.subarray(at(field), at(field) + 32));
  const statusByte = data[at("status")];
  const status = LEASE_STATUS[statusByte!];
  if (status === undefined) throw new LeaseDecodeError(`unknown lease status byte ${statusByte}`);
  return {
    landlord: address("landlord"),
    tenant: address("tenant"),
    mint: address("mint"),
    leaseId: view.getBigUint64(at("lease_id"), true),
    rentAmount: view.getBigUint64(at("rent_amount"), true),
    depositAmount: view.getBigUint64(at("deposit_amount"), true),
    startTs: view.getBigInt64(at("start_ts"), true),
    termPeriods: view.getUint16(at("term_periods"), true),
    paidCount: view.getUint16(at("paid_count"), true),
    status,
  };
}

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
