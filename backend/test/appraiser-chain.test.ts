import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AccountRole, generateKeyPairSigner, getAddressEncoder, type Address } from "@solana/kit";
import { appraiserPda, decodeAppraiser, decodeDispute, disputePda, getRegisterAppraiserInstruction, getSetAppraiserActiveInstruction, getSetDefaultAppraiserInstruction, getSubmitVerdictInstruction, verdictSplit } from "../src/appraiser-chain.ts";
import { configPda } from "../src/anchor.ts";
import { FALLBACK_LAYOUTS } from "../src/layout.ts";
import { accountDiscriminator } from "../src/anchor.ts";
import { account, instruction } from "./idlfixtures.ts";

const enc = getAddressEncoder();
const key = async () => (await generateKeyPairSigner()).address;

describe("discriminators and account order match the IDL", () => {
  it("accounts", () => {
    for (const n of ["Appraiser", "Dispute"]) assert.deepEqual([...accountDiscriminator(n)], account(n).discriminator);
  });
  const roles = (names: { name: string; writable?: boolean; signer?: boolean }[]) =>
    names.map((a) => (a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY));

  it("register_appraiser / set_* / submit_verdict", async () => {
    const admin = await generateKeyPairSigner();
    const wallet = await key();
    const reg = await getRegisterAppraiserInstruction({ admin, wallet, fee: 5n, nameHash: new Uint8Array(32).fill(1) });
    assert.deepEqual([...reg.data!.subarray(0, 8)], instruction("register_appraiser").discriminator);
    assert.deepEqual(reg.accounts!.map((a) => a.role), roles(instruction("register_appraiser").accounts));
    assert.equal(reg.accounts![2]!.address, await appraiserPda(wallet));
    assert.equal(reg.accounts![1]!.address, await configPda());
    assert.equal(reg.data!.length, 8 + 32 + 8 + 32);

    const act = await getSetAppraiserActiveInstruction({ admin, wallet, active: false });
    assert.deepEqual([...act.data!.subarray(0, 8)], instruction("set_appraiser_active").discriminator);
    assert.deepEqual(act.accounts!.map((a) => a.role), roles(instruction("set_appraiser_active").accounts));
    const def = await getSetDefaultAppraiserInstruction({ admin, wallet, isDefault: true });
    assert.deepEqual([...def.data!.subarray(0, 8)], instruction("set_default_appraiser").discriminator);
    assert.equal(def.data![8], 1);
    assert.deepEqual(def.accounts!.map((a) => a.role), roles(instruction("set_default_appraiser").accounts));

    const [appraiser, lease, landlord, tenant, mint, tokenProgram] = [await generateKeyPairSigner(), await key(), await key(), await key(), await key(), await key()];
    const v = await getSubmitVerdictInstruction({ appraiser, lease, landlord, tenant, mint, tokenProgram, deduction: 7n });
    assert.deepEqual([...v.data!.subarray(0, 8)], instruction("submit_verdict").discriminator);
    assert.deepEqual(v.accounts!.map((a) => a.role), roles(instruction("submit_verdict").accounts));
    assert.equal(v.accounts!.length, instruction("submit_verdict").accounts.length);
    assert.equal(v.accounts![3]!.address, await disputePda(lease));
  });

  it("refuses the all-zero wallet and a short name hash", async () => {
    const admin = await generateKeyPairSigner();
    await assert.rejects(getRegisterAppraiserInstruction({ admin, wallet: "11111111111111111111111111111111" as Address, fee: 1n, nameHash: new Uint8Array(32) }), /all-zero/);
    await assert.rejects(getRegisterAppraiserInstruction({ admin, wallet: await key(), fee: 1n, nameHash: new Uint8Array(31) }), /32 bytes/);
  });
});

describe("decoders", () => {
  it("Appraiser", async () => {
    const wallet = await key();
    const d = new Uint8Array(FALLBACK_LAYOUTS.Appraiser!.size);
    d.set(accountDiscriminator("Appraiser"));
    d.set(enc.encode(wallet), 8);
    d[40] = 1; d[41] = 1;
    new DataView(d.buffer).setBigUint64(42, 123n, true);
    d.fill(0xab, 50, 82);
    assert.deepEqual(decodeAppraiser(d), { wallet, active: true, isDefault: true, fee: 123n, nameHash: "ab".repeat(32) });
  });
  it("Dispute: unbound is null, counts bound the candidate lists", async () => {
    const [lease, a, b] = [await key(), await key(), await key()];
    const L = FALLBACK_LAYOUTS.Dispute!;
    const d = new Uint8Array(L.size);
    d.set(accountDiscriminator("Dispute"));
    d.set(enc.encode(lease), 8);
    d.set(enc.encode(a), 40); d.set(enc.encode(b), 72);
    d[232] = 2; d[233] = 0;
    new DataView(d.buffer).setBigInt64(330, 100n, true);
    new DataView(d.buffer).setBigInt64(338, 200n, true);
    const r = decodeDispute(d);
    assert.deepEqual(r.landlordCandidates, [a, b]);
    assert.deepEqual(r.tenantCandidates, []);
    assert.equal(r.appraiser, null);
    assert.equal(r.verdictDeadline, 200);
  });
  it("rejects a wrong discriminator or size", () => {
    assert.throws(() => decodeAppraiser(new Uint8Array(83)), /discriminator/);
    const d = new Uint8Array(10); d.set(accountDiscriminator("Appraiser"));
    assert.throws(() => decodeAppraiser(d), /83-byte/);
  });
});

describe("verdictSplit (docs §6)", () => {
  const conserves = (dep: bigint, ded: bigint, fee: bigint) => {
    const s = verdictSplit(dep, ded, fee);
    assert.equal(s.toTenant + s.toLandlord + s.feePaid, dep);
    return s;
  };
  it("landlord won: tenant pays the fee, clamped to the refund", () => {
    const s = conserves(1000n, 900n, 50n);
    assert.deepEqual([s.toTenant, s.toLandlord, s.feePaid, s.landlordWon], [50n, 900n, 50n, true]);
    const c = conserves(1000n, 1000n, 50n); // refund 0 -> fee 0
    assert.equal(c.feePaid, 0n);
  });
  it("tenant won: landlord pays as far as their share reaches, then the tenant", () => {
    const s = conserves(1000n, 40n, 50n); // cap 100, fee 50, landlord covers 40, tenant 10
    assert.deepEqual([s.toTenant, s.toLandlord, s.feePaid], [950n, 0n, 50n]);
    const z = conserves(1000n, 0n, 50n); // known limitation: tenant pays on d=0
    assert.deepEqual([z.toTenant, z.toLandlord], [950n, 0n]);
  });
  it("caps the fee at deposit/10 and treats exactly half as tenant won", () => {
    assert.equal(conserves(1000n, 200n, 10_000n).fee, 100n);
    assert.equal(verdictSplit(1000n, 500n, 1n).landlordWon, false);
    assert.equal(verdictSplit(1000n, 501n, 1n).landlordWon, true);
  });
  it("sweeps all deductions for conservation", () => {
    for (let ded = 0n; ded <= 100n; ded++) for (const fee of [0n, 1n, 7n, 10n, 99n]) conserves(100n, ded, fee);
  });
  it("refuses a deduction above the deposit", () => assert.throws(() => verdictSplit(10n, 11n, 0n), /cannot deduct/));
});
