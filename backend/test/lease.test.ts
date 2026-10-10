import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddressEncoder, getBase64Decoder, type Address, type GetAccountInfoApi, type Rpc } from "@solana/kit";
import { LEASE_ACCOUNT_SIZE, LEASE_STATUS, LeaseDecodeError, LeaseNotFound, decodeLease, fetchLease } from "../src/lease.ts";

const PROGRAM = "G4iMjveQKXztnGoxigAeWPrb5evT9yt6qaLkgQEp2dXm" as Address;
const LANDLORD = "EBMibFLTvr5GDpgxNqt5Gqp9B1xLMr32aNwGDJV2oGJ6" as Address;
const TENANT = "11111111111111111111111111111112" as Address;
const MINT = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

/** A Lease account laid out as programs/relstate/src/state.rs does, with every read field distinct. */
function leaseBytes(status = 1, size = LEASE_ACCOUNT_SIZE): Uint8Array {
  const data = new Uint8Array(size);
  const view = new DataView(data.buffer);
  const put = (offset: number, address: Address) => data.set(getAddressEncoder().encode(address), offset);
  put(8, LANDLORD);
  put(40, TENANT);
  put(72, MINT);
  view.setBigUint64(104, 0x0102030405060708n, true);
  view.setBigUint64(112, 2_000_000n, true);
  view.setBigUint64(120, 4_000_000n, true);
  view.setBigInt64(128, -1_700_000_000n, true);
  view.setUint16(136, 12, true);
  view.setUint16(138, 3, true);
  data[172] = status;
  return data;
}

const rpcReturning = (value: unknown) =>
  ({ getAccountInfo: () => ({ send: async () => ({ value }) }) }) as unknown as Rpc<GetAccountInfoApi>;
const account = (data: Uint8Array, owner: Address = PROGRAM) => ({ owner, data: [getBase64Decoder().decode(data), "base64"] });

describe("decodeLease", () => {
  it("reads every field from its little-endian offset", () => {
    assert.deepEqual(decodeLease(leaseBytes()), {
      landlord: LANDLORD,
      tenant: TENANT,
      mint: MINT,
      leaseId: 0x0102030405060708n,
      rentAmount: 2_000_000n,
      depositAmount: 4_000_000n,
      startTs: -1_700_000_000n,
      termPeriods: 12,
      paidCount: 3,
      status: "active",
    });
  });

  it("reads correctly from a view that does not start at byte zero of its buffer", () => {
    const padded = new Uint8Array(LEASE_ACCOUNT_SIZE + 7);
    padded.set(leaseBytes(), 7);
    assert.equal(decodeLease(padded.subarray(7)).rentAmount, 2_000_000n);
  });

  // The guard against the hand-written offsets rotting: a field added to Lease changes its size.
  it("rejects data shorter than the Lease account", () => {
    assert.throws(() => decodeLease(leaseBytes(1, LEASE_ACCOUNT_SIZE - 1)), LeaseDecodeError);
  });

  it("rejects data longer than the Lease account", () => {
    assert.throws(() => decodeLease(leaseBytes(1, LEASE_ACCOUNT_SIZE + 1)), LeaseDecodeError);
  });

  it("names the expected and actual size so a layout change is diagnosable", () => {
    assert.throws(() => decodeLease(new Uint8Array(200)), /193-byte.*200 bytes/s);
  });

  for (const [byte, name] of LEASE_STATUS.entries()) {
    it(`maps status byte ${byte} to ${name}`, () => {
      assert.equal(decodeLease(leaseBytes(byte)).status, name);
    });
  }

  it("rejects a status byte outside the known set", () => {
    assert.throws(() => decodeLease(leaseBytes(4)), LeaseDecodeError);
  });
});

describe("fetchLease", () => {
  it("returns the decoded lease for a program-owned account", async () => {
    const lease = await fetchLease(rpcReturning(account(leaseBytes())), TENANT, PROGRAM);
    assert.equal(lease.rentAmount, 2_000_000n);
    assert.equal(lease.landlord, LANDLORD);
  });

  it("throws LeaseNotFound when there is no account", async () => {
    await assert.rejects(fetchLease(rpcReturning(null), TENANT, PROGRAM), LeaseNotFound);
  });

  // The owner check is the only thing stopping a caller pointing the auditor at an account they
  // wrote themselves, with whatever rent_amount makes a wrong payment verify.
  it("throws LeaseNotFound for a well-formed lease owned by another program", async () => {
    const forged = account(leaseBytes(), LANDLORD);
    await assert.rejects(fetchLease(rpcReturning(forged), TENANT, PROGRAM), LeaseNotFound);
  });

  it("surfaces a wrong-sized program-owned account as a decode error, not as not-found", async () => {
    await assert.rejects(fetchLease(rpcReturning(account(new Uint8Array(10))), TENANT, PROGRAM), LeaseDecodeError);
  });
});
