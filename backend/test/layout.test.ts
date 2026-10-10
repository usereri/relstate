import "./noenv.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddressEncoder, generateKeyPairSigner } from "@solana/kit";
import { FALLBACK_LAYOUTS, IDL_PATH, accountLayout, computeLayout, fieldOffset, type Idl } from "../src/layout.ts";
import { LEASE_DISCRIMINATOR, decodeLease } from "../src/lease.ts";

// The program's Lease and Profile are about to change before the first deploy. These tests are what
// makes that a one-file update: the layout is computed from the IDL, the snapshot used when no IDL is
// on disk is pinned to it, and the readers follow whatever the layout says.

const idl: Idl | null = existsSync(IDL_PATH()) ? (JSON.parse(readFileSync(IDL_PATH(), "utf8")) as Idl) : null;

describe("computeLayout", () => {
  const sample: Idl = {
    types: [
      { name: "Flag", type: { kind: "enum", variants: [{ name: "A" }, { name: "B" }] } },
      { name: "Thing", type: { kind: "struct", fields: [{ name: "a", type: "u8" }, { name: "key", type: "pubkey" }, { name: "n", type: "u64" }, { name: "tag", type: { array: ["u8", 5] } }, { name: "f", type: { defined: { name: "Flag" } } }, { name: "maybe", type: { option: "u32" } }] } },
      { name: "Names", type: { kind: "struct", fields: [{ name: "s", type: "string" }] } },
    ],
  };

  it("lays fields out in order after the 8-byte discriminator", () => {
    const layout = computeLayout(sample, "Thing");
    assert.deepEqual(layout.offsets, { a: 8, key: 9, n: 41, tag: 49, f: 54, maybe: 55 });
    assert.equal(layout.size, 8 + 1 + 32 + 8 + 5 + 1 + 5);
  });

  it("refuses a variable-length field rather than inventing a size for it", () => {
    assert.throws(() => computeLayout(sample, "Names"), /unsupported field type string/);
  });

  it("refuses an account the IDL does not have", () => {
    assert.throws(() => computeLayout(sample, "Missing"), /no struct account Missing/);
  });
});

describe("the fallback snapshot", () => {
  // The single place to update when the program's accounts change. Fails with the three names so the
  // fix is a copy-paste, not a hunt.
  it("equals what the program's IDL says (skipped when no IDL has been built)", { skip: idl === null }, () => {
    for (const name of Object.keys(FALLBACK_LAYOUTS)) {
      const live = computeLayout(idl!, name);
      assert.deepEqual(FALLBACK_LAYOUTS[name], live, `FALLBACK_LAYOUTS.${name} in backend/src/layout.ts is stale: the program's ${name} is now ${JSON.stringify(live)}`);
    }
  });

  it("covers every account this backend reads or sizes", () => {
    assert.deepEqual(Object.keys(FALLBACK_LAYOUTS).sort(), ["Application", "Lease", "Profile"]);
  });

  it("is what accountLayout returns when there is no IDL", () => {
    assert.deepEqual(accountLayout("Profile", null), FALLBACK_LAYOUTS.Profile);
    assert.throws(() => accountLayout("Nope", null), /no fallback layout/);
  });
});

const withDiscriminator = (size: number) => {
  const data = new Uint8Array(size);
  data.set(LEASE_DISCRIMINATOR, 0);
  return data;
};

describe("decodeLease follows the layout", () => {
  // A new field inserted BEFORE rent_amount shifts every later offset. With hand-copied offsets this
  // returns a plausible wrong figure; reading them from the layout it still returns the right one.
  it("reads the right figures when the program inserts a field ahead of them", async () => {
    const base = FALLBACK_LAYOUTS.Lease!;
    const shift = 8;
    const shifted = {
      size: base.size + shift,
      offsets: Object.fromEntries(Object.entries(base.offsets).map(([k, v]) => [k, v >= base.offsets.lease_id! ? v + shift : v])),
    };
    const data = new Uint8Array(shifted.size);
    const view = new DataView(data.buffer);
    data.set(LEASE_DISCRIMINATOR, 0);
    const [landlord, tenant, mint] = await Promise.all([0, 1, 2].map(async () => (await generateKeyPairSigner()).address));
    for (const [field, address] of [["landlord", landlord], ["tenant", tenant], ["mint", mint]] as const) data.set(getAddressEncoder().encode(address!), shifted.offsets[field]!);
    view.setBigUint64(shifted.offsets.rent_amount!, 1_234_567n, true);
    view.setBigUint64(shifted.offsets.deposit_amount!, 2_000_000n, true);
    view.setUint16(shifted.offsets.paid_count!, 2, true);
    data[shifted.offsets.status!] = 1;
    const lease = decodeLease(data, shifted);
    assert.equal(lease.rentAmount, 1_234_567n);
    assert.equal(lease.depositAmount, 2_000_000n);
    assert.equal(lease.paidCount, 2);
    assert.equal(lease.status, "active");
    assert.equal(lease.landlord, landlord);
  });

  it("names the field when the program no longer has one the reader needs", () => {
    const { rent_amount: _gone, ...rest } = FALLBACK_LAYOUTS.Lease!.offsets;
    assert.throws(() => decodeLease(withDiscriminator(FALLBACK_LAYOUTS.Lease!.size), { size: FALLBACK_LAYOUTS.Lease!.size, offsets: rest }), /Lease has no field rent_amount/);
    assert.throws(() => fieldOffset(FALLBACK_LAYOUTS.Lease!, "Lease", "dispute_state"), /no field dispute_state/);
  });
});
