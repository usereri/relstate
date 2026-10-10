import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AccountRole,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64Decoder,
  type Address,
  type Instruction,
} from "@solana/kit";
import { getConfidentialTransferInstructionDataEncoder } from "@solana-program/token-2022";
import { ConfidentialKeys } from "@solana/zk-sdk";

const { createApp } = await import("../src/server.ts");
const { createSessionToken } = await import("../src/auth.ts");
const { ServiceUnavailable } = await import("../src/services.ts");
import type { Services } from "../src/services.ts";
import { RELSTATE_PROGRAM } from "../src/contracts.ts";
import { LEASE_ACCOUNT_SIZE } from "../src/lease.ts";
import { PAY_RENT_DISCRIMINATOR } from "../src/rentshape.ts";
import { TOKEN_PROGRAM, buildTx } from "./txfixtures.ts";

const PROGRAM = RELSTATE_PROGRAM as Address;
const RENT = 2_000_000n;
const SIGNATURE = "5".repeat(88);
const auditor = ConfidentialKeys.fromIkm(new Uint8Array(32).fill(7));

/** A Lease account with `rent_amount` = RENT, owned by the relstate program. */
function leaseAccount(tenant: Address, landlord: Address, owner: Address = PROGRAM) {
  const data = new Uint8Array(LEASE_ACCOUNT_SIZE);
  const view = new DataView(data.buffer);
  data.set(getAddressEncoder().encode(landlord), 8);
  data.set(getAddressEncoder().encode(tenant), 40);
  view.setBigUint64(112, RENT, true);
  data[172] = 1;
  return { owner, data: [getBase64Decoder().decode(data), "base64"] };
}

/**
 * A real wire transaction of `[confidential Transfer, pay_rent]` whose auditor ciphertexts encrypt
 * `amount`. The proofs and balances are zeroed: the audit only ever reads the auditor halves.
 */
async function paymentTx(amount: bigint, lease: Address, undecryptable = false): Promise<string> {
  const pubkey = auditor.elgamal().pubkey();
  const payer = await generateKeyPairSigner();
  const [source, mint, destination] = await Promise.all([1, 2, 3].map(async () => (await generateKeyPairSigner()).address));
  const transfer = {
    programAddress: TOKEN_PROGRAM,
    accounts: [source, mint, destination].map((address) => ({ address, role: AccountRole.WRITABLE })),
    data: new Uint8Array(
      getConfidentialTransferInstructionDataEncoder().encode({
        newSourceDecryptableAvailableBalance: new Uint8Array(36),
        transferAmountAuditorCiphertextLo: undecryptable ? new Uint8Array(64).fill(0xff) : pubkey.encryptU64(amount & 0xffffn).toBytes(),
        transferAmountAuditorCiphertextHi: undecryptable ? new Uint8Array(64).fill(0xff) : pubkey.encryptU64(amount >> 16n).toBytes(),
        equalityProofInstructionOffset: 1,
        ciphertextValidityProofInstructionOffset: 2,
        rangeProofInstructionOffset: 3,
      }),
    ),
  } as unknown as Instruction;
  // A real pay_rent: the Anchor discriminator, and [tenant, lease, ...] as its first two accounts.
  const payRent = {
    programAddress: PROGRAM,
    accounts: [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
      { address: lease, role: AccountRole.WRITABLE },
    ],
    data: PAY_RENT_DISCRIMINATOR,
  } as unknown as Instruction;
  return buildTx({ feePayer: payer.address, instructions: [transfer, payRent] });
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(options: { lease?: "known" | "missing" | "foreign"; settled?: bigint; auditorDown?: boolean; payment?: "own" | "of-another-lease"; undecryptable?: boolean } = {}) {
  const tenant = (await generateKeyPairSigner()).address;
  const landlord = (await generateKeyPairSigner()).address;
  const stranger = (await generateKeyPairSigner()).address;
  const lease = (await generateKeyPairSigner()).address;
  const otherLease = (await generateKeyPairSigner()).address;
  const wire = await paymentTx(options.settled ?? RENT, options.payment === "of-another-lease" ? otherLease : lease, options.undecryptable);
  const calls = { getAccountInfo: 0, getTransaction: 0 };
  const rpc = {
    getAccountInfo: () => ({
      send: async () => {
        calls.getAccountInfo++;
        if (options.lease === "missing") return { value: null };
        return { value: leaseAccount(tenant, landlord, options.lease === "foreign" ? tenant : PROGRAM) };
      },
    }),
    getTransaction: () => ({
      send: async () => {
        calls.getTransaction++;
        return { transaction: [wire, "base64"] };
      },
    }),
  };
  const services = {
    client: () => ({ rpc }),
    auditor: () => {
      if (options.auditorDown) throw new ServiceUnavailable("no auditor seed");
      return { keys: { elgamal: auditor.elgamal() } };
    },
  } as unknown as Services;
  const app = createApp(services);
  const as = (wallet: Address, body: unknown) =>
    app.request("/api/rent/verify", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${createSessionToken(wallet).token}` },
      body: JSON.stringify(body),
    });
  return { app, tenant, landlord, stranger, lease, calls, as };
}
const valid = (f: Fixture) => ({ signature: SIGNATURE, lease: f.lease });

describe("POST /api/rent/verify: session", () => {
  it("rejects a request with no authorization header", async () => {
    const f = await fixture();
    const res = await f.app.request("/api/rent/verify", { method: "POST", body: JSON.stringify(valid(f)) });
    assert.equal(res.status, 401);
    assert.equal(f.calls.getAccountInfo, 0);
  });

  it("rejects a forged token", async () => {
    const f = await fixture();
    const res = await f.app.request("/api/rent/verify", {
      method: "POST",
      headers: { authorization: "Bearer e30.AAAA" },
      body: JSON.stringify(valid(f)),
    });
    assert.equal(res.status, 401);
  });
});

describe("POST /api/rent/verify: body", () => {
  it("rejects a missing signature", async () => {
    const f = await fixture();
    const res = await f.as(f.tenant, { lease: f.lease });
    assert.equal(res.status, 400);
    assert.equal(f.calls.getAccountInfo, 0);
  });

  it("rejects a lease that is not an address", async () => {
    const f = await fixture();
    const res = await f.as(f.tenant, { signature: SIGNATURE, lease: "not-an-address" });
    assert.equal(res.status, 400);
    assert.equal(f.calls.getAccountInfo, 0);
  });
});

describe("POST /api/rent/verify: who may ask", () => {
  // The answer is a rent amount, which docs/privacy.md promises to keep private; a stranger must
  // not be able to distinguish "not your lease" from "no such lease".
  it("answers a stranger exactly as it answers an unknown lease", async () => {
    const stranger = await fixture();
    const unknown = await fixture({ lease: "missing" });
    const a = await stranger.as(stranger.stranger, valid(stranger));
    const b = await unknown.as(unknown.stranger, valid(unknown));
    assert.equal(a.status, 404);
    assert.equal(b.status, 404);
    const [textA, textB] = [await a.text(), await b.text()];
    assert.equal(JSON.parse(textA).code, "lease-unknown");
    // Lease addresses differ per fixture, so compare with the address masked out.
    assert.equal(textA.replace(stranger.lease, "L"), textB.replace(unknown.lease, "L"));
    assert.equal(stranger.calls.getTransaction, 0, "a stranger's request must not even fetch the transaction");
  });

  it("treats an account owned by another program as an unknown lease", async () => {
    const f = await fixture({ lease: "foreign" });
    const res = await f.as(f.tenant, valid(f));
    assert.equal(res.status, 404);
    assert.equal((await res.json() as { code: string }).code, "lease-unknown");
  });

  for (const party of ["tenant", "landlord"] as const) {
    it(`lets the ${party} verify`, async () => {
      const f = await fixture();
      const res = await f.as(f[party], valid(f));
      assert.equal(res.status, 200);
    });
  }
});

describe("POST /api/rent/verify: the audit", () => {
  it("reports ok when the decrypted amount equals the lease's rent", async () => {
    const f = await fixture();
    const body = (await (await f.as(f.tenant, valid(f))).json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.settledAmount, RENT.toString());
    assert.equal(body.expectedAmount, RENT.toString());
    assert.equal(body.reason, null);
  });

  // A wrong amount is a successful audit with a negative result, not a failure to audit.
  it("answers 200 with ok false and a reason when the amount differs", async () => {
    const f = await fixture({ settled: RENT - 1n });
    const res = await f.as(f.tenant, valid(f));
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.equal(body.settledAmount, (RENT - 1n).toString());
    assert.match(String(body.reason), /settled/);
    // The accounts of the transfer are no longer echoed: nothing here needs them.
    assert.equal((body.transfer as Record<string, unknown>).sourceToken, undefined);
    assert.equal((body.transfer as Record<string, unknown>).destinationToken, undefined);
  });

  it("takes the expected amount from the lease, ignoring one smuggled into the body", async () => {
    const f = await fixture({ settled: 5n });
    const res = await f.as(f.tenant, { ...valid(f), expectedAmount: "5", rentAmount: "5", amount: "5" });
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.equal(body.expectedAmount, RENT.toString());
  });

  // The regression for the decryption oracle. Authorisation is per LEASE and decryption is per
  // TRANSACTION; a caller who is a genuine party to one lease must not be able to name some other
  // payment's signature and read its amount. The existing tests all used a transaction that belonged
  // to the lease being asked about, which is exactly the direction that cannot show this.
  describe("a payment that belongs to a different lease", () => {
    it("is refused as an unknown lease, and leaks neither the amount nor the accounts", async () => {
      const f = await fixture({ payment: "of-another-lease", settled: 7_654_321n });
      const res = await f.as(f.tenant, valid(f)); // f.tenant IS a party to f.lease
      assert.equal(res.status, 404);
      const text = await res.text();
      assert.equal(JSON.parse(text).code, "lease-unknown");
      for (const secret of ["7654321", "settledAmount", "sourceToken", "destinationToken", "reason"]) {
        assert.ok(!text.includes(secret), `the refusal leaked ${secret}`);
      }
    });

    it("answers byte-for-byte like a lease that does not exist", async () => {
      const mismatch = await fixture({ payment: "of-another-lease" });
      const unknown = await fixture({ lease: "missing" });
      const a = await (await mismatch.as(mismatch.tenant, valid(mismatch))).text();
      const b = await (await unknown.as(unknown.tenant, valid(unknown))).text();
      assert.equal(a.replace(mismatch.lease, "L"), b.replace(unknown.lease, "L"));
    });

    // If the route decrypted before comparing, ciphertext that cannot be decrypted would surface as a
    // server error. A clean 404 therefore shows the lease is decided from the transaction's accounts
    // alone, before the transfer is touched.
    it("decrypts nothing: undecryptable ciphertext still gets the clean 404", async () => {
      const f = await fixture({ payment: "of-another-lease", undecryptable: true });
      assert.equal((await f.as(f.tenant, valid(f))).status, 404);
      const control = await fixture({ payment: "own", undecryptable: true });
      assert.notEqual((await control.as(control.tenant, valid(control))).status, 200, "the control must actually fail to decrypt");
    });
  });

  it("answers 503 when no auditor key is configured", async () => {
    const f = await fixture({ auditorDown: true });
    const res = await f.as(f.tenant, valid(f));
    assert.equal(res.status, 503);
    assert.equal((await res.json() as { code: string }).code, "unavailable");
  });
});
