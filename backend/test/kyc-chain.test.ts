import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AccountRole, generateKeyPairSigner, getAddressEncoder, type Address } from "@solana/kit";

const chain = await import("../src/providers/kyc-chain.ts");
const { RELSTATE_PROGRAM, SYSTEM_PROGRAM } = await import("../src/contracts.ts");
const { NO_ISSUER, accountDiscriminator, attestationPda, configPda, decodeAttestation, decodeKycPolicy, getAttestInstruction, getRevokeInstruction, instructionDiscriminator, isValid } = chain;
import type { AttestationAccount, KycPolicy } from "../src/providers/kyc-chain.ts";
// The IDL is the program's own statement of its wire format; a rename or reorder there must fail
// here. Read through the fixture so the tracked copy in app/idl/ is used when target/ is absent,
// which it is in CI and in any worktree that has not run `anchor build`.
import { account as acct, instruction as ix } from "./idlfixtures.ts";

const enc = getAddressEncoder();
const WALLET = "EBMibFLTvr5GDpgxNqt5Gqp9B1xLMr32aNwGDJV2oGJ6" as Address;
const OTHER = "11111111111111111111111111111112" as Address;
const hash32 = (fill: number) => new Uint8Array(32).fill(fill);

describe("discriminators match the generated IDL", () => {
  it("attest and revoke", () => {
    assert.deepEqual([...instructionDiscriminator("attest")], ix("attest").discriminator);
    assert.deepEqual([...instructionDiscriminator("revoke")], ix("revoke").discriminator);
  });

  it("Attestation and Config accounts", () => {
    assert.deepEqual([...accountDiscriminator("Attestation")], acct("Attestation").discriminator);
    assert.deepEqual([...accountDiscriminator("Config")], acct("Config").discriminator);
  });
});

describe("PDAs", () => {
  it("are deterministic, and the attestation differs per wallet", async () => {
    assert.equal(await attestationPda(WALLET), await attestationPda(WALLET));
    assert.notEqual(await attestationPda(WALLET), await attestationPda(OTHER));
    assert.equal(await configPda(), await configPda());
    assert.notEqual(await configPda(), await attestationPda(WALLET));
  });
});

describe("getAttestInstruction", () => {
  const build = async (patch: Record<string, unknown> = {}) => {
    const payer = await generateKeyPairSigner();
    const issuer = await generateKeyPairSigner();
    const input = { payer, issuer, wallet: WALLET, level: 1, expiresAt: 1_800_000_000, subjectHash: hash32(0xab), ...patch };
    return { payer, issuer, instruction: await getAttestInstruction(input as Parameters<typeof getAttestInstruction>[0]) };
  };

  it("lists accounts in the IDL's order with the IDL's roles", async () => {
    const { payer, issuer, instruction } = await build();
    const expected = ix("attest").accounts;
    assert.equal(instruction.programAddress, RELSTATE_PROGRAM);
    assert.equal(instruction.accounts!.length, expected.length);

    const addressOf: Record<string, Address> = {
      payer: payer.address,
      config: await configPda(),
      issuer: issuer.address,
      wallet: WALLET,
      attestation: await attestationPda(WALLET),
      system_program: SYSTEM_PROGRAM as Address,
    };
    expected.forEach((want, i) => {
      const got = instruction.accounts![i]!;
      assert.equal(got.address, addressOf[want.name], `account ${i} (${want.name})`);
      const role = want.signer ? (want.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : want.writable ? AccountRole.WRITABLE : AccountRole.READONLY;
      assert.equal(got.role, role, `role of ${want.name}`);
    });
  });

  it("attaches the signers to the payer and issuer metas, and to nothing else", async () => {
    const { payer, issuer, instruction } = await build();
    const metas = instruction.accounts as unknown as Array<{ signer?: unknown }>;
    assert.equal(metas[0]!.signer, payer);
    assert.equal(metas[2]!.signer, issuer);
    assert.deepEqual(
      metas.map((m) => m.signer !== undefined),
      [true, false, true, false, false, false],
    );
  });

  it("encodes [disc][level u8][expires_at i64 LE][subject_hash 32]", async () => {
    const { instruction } = await build({ level: 2, expiresAt: 0x0102030405, subjectHash: hash32(7) });
    const data = instruction.data as Uint8Array;
    assert.equal(data.length, 8 + 1 + 8 + 32);
    assert.deepEqual([...data.subarray(0, 8)], ix("attest").discriminator);
    assert.equal(data[8], 2);
    assert.equal(new DataView(data.buffer, data.byteOffset).getBigInt64(9, true), 0x0102030405n);
    assert.deepEqual([...data.subarray(17)], [...hash32(7)]);
  });

  it("encodes a never-expiring attestation as zero", async () => {
    const { instruction } = await build({ expiresAt: 0 });
    assert.equal(new DataView((instruction.data as Uint8Array).buffer).getBigInt64(9, true), 0n);
  });

  it("rejects a subject hash that is not 32 bytes", async () => {
    for (const len of [0, 31, 33, 64]) await assert.rejects(build({ subjectHash: new Uint8Array(len) }), /32 bytes/);
  });

  it("rejects a level outside 1..2", async () => {
    // The program refuses these too; failing here saves a transaction that can only fail on chain.
    for (const level of [0, 3, -1, 1.5, Number.NaN]) await assert.rejects(build({ level }), /level must be 1 or 2/);
  });

  it("rejects a negative or fractional expiry", async () => {
    for (const expiresAt of [-1, 1.5, Number.NaN]) await assert.rejects(build({ expiresAt }), /non-negative/);
  });
});

describe("getRevokeInstruction", () => {
  it("lists accounts in the IDL's order and carries only the discriminator", async () => {
    const issuer = await generateKeyPairSigner();
    const instruction = await getRevokeInstruction({ issuer, wallet: WALLET });
    const expected = ix("revoke").accounts;
    assert.equal(instruction.accounts!.length, expected.length);

    const addressOf: Record<string, Address> = {
      config: await configPda(),
      issuer: issuer.address,
      wallet: WALLET,
      attestation: await attestationPda(WALLET),
    };
    expected.forEach((want, i) => {
      const got = instruction.accounts![i]!;
      assert.equal(got.address, addressOf[want.name], want.name);
      const role = want.signer ? AccountRole.READONLY_SIGNER : want.writable ? AccountRole.WRITABLE : AccountRole.READONLY;
      assert.equal(got.role, role, `role of ${want.name}`);
    });
    assert.equal((instruction.accounts![1] as { signer?: unknown }).signer, issuer);
    assert.deepEqual([...(instruction.data as Uint8Array)], ix("revoke").discriminator);
  });
});

/** The account layout `decodeAttestation` documents, built by hand so the decoder is checked against bytes. */
function attestationBytes(a: { wallet: Address; issuer: Address; level: number; verifiedAt: number; expiresAt: number; revoked: boolean; hash: Uint8Array }, extra = 0) {
  const data = new Uint8Array(123 + extra);
  const view = new DataView(data.buffer);
  data.set(accountDiscriminator("Attestation"), 0);
  data.set(enc.encode(a.wallet), 8);
  data.set(enc.encode(a.issuer), 40);
  data[72] = a.level;
  view.setBigInt64(73, BigInt(a.verifiedAt), true);
  view.setBigInt64(81, BigInt(a.expiresAt), true);
  data[89] = a.revoked ? 1 : 0;
  data.set(a.hash, 90);
  data[122] = 254; // bump
  return data;
}

describe("decodeAttestation", () => {
  const sample = { wallet: WALLET, issuer: OTHER, level: 2, verifiedAt: 1_700_000_000, expiresAt: 1_800_000_000, revoked: false, hash: hash32(0xcd) };

  it("round-trips a hand-built buffer", () => {
    assert.deepEqual(decodeAttestation(attestationBytes(sample)), {
      wallet: WALLET,
      issuer: OTHER,
      level: 2,
      verifiedAt: 1_700_000_000,
      expiresAt: 1_800_000_000,
      revoked: false,
      subjectHash: "cd".repeat(32),
    });
  });

  it("reads revoked and the hash independently of each other", () => {
    const out = decodeAttestation(attestationBytes({ ...sample, revoked: true, hash: Uint8Array.from({ length: 32 }, (_, i) => i) }))!;
    assert.equal(out.revoked, true);
    assert.equal(out.subjectHash, Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0")).join(""));
  });

  it("decodes a view into a larger buffer (non-zero byteOffset)", () => {
    const inner = attestationBytes(sample);
    const padded = new Uint8Array(inner.length + 5);
    padded.set(inner, 5);
    assert.equal(decodeAttestation(padded.subarray(5))!.level, 2);
  });

  it("tolerates trailing bytes", () => {
    assert.equal(decodeAttestation(attestationBytes(sample, 16))!.level, 2);
  });

  it("returns null for a wrong discriminator", () => {
    // An account at the right address but of another type must not read as a verified identity.
    const data = attestationBytes(sample);
    data[0] = data[0]! ^ 0xff;
    assert.equal(decodeAttestation(data), null);
    const config = attestationBytes(sample);
    config.set(accountDiscriminator("Config"), 0);
    assert.equal(decodeAttestation(config), null);
  });

  it("returns null for a short buffer", () => {
    assert.equal(decodeAttestation(attestationBytes(sample).subarray(0, 122)), null);
    assert.equal(decodeAttestation(new Uint8Array(0)), null);
    assert.equal(decodeAttestation(accountDiscriminator("Attestation")), null);
  });
});

/** `Config`: disc, admin, bump, mints vec, then (optionally) issuer + require_kyc. */
function configBytes(mints: number, kyc?: { issuer: Address; requireKyc: boolean }) {
  const data = new Uint8Array(8 + 32 + 1 + 4 + mints * 32 + (kyc === undefined ? 0 : 33));
  data.set(accountDiscriminator("Config"), 0);
  new DataView(data.buffer).setUint32(41, mints, true);
  for (let i = 0; i < mints; i++) data.fill(0x11 + i, 45 + i * 32, 45 + (i + 1) * 32);
  if (kyc !== undefined) {
    const at = 45 + mints * 32;
    data.set(enc.encode(kyc.issuer), at);
    data[at + 32] = kyc.requireKyc ? 1 : 0;
  }
  return data;
}

describe("decodeKycPolicy", () => {
  for (const mints of [0, 1, 8]) {
    it(`finds issuer and requireKyc after ${mints} mint(s)`, () => {
      assert.deepEqual(decodeKycPolicy(configBytes(mints, { issuer: WALLET, requireKyc: true })), { issuer: WALLET, requireKyc: true });
      assert.deepEqual(decodeKycPolicy(configBytes(mints, { issuer: OTHER, requireKyc: false })), { issuer: OTHER, requireKyc: false });
    });

    it(`reads an older config with ${mints} mint(s) and no KYC fields as "no issuer, gate off"`, () => {
      assert.deepEqual(decodeKycPolicy(configBytes(mints)), { issuer: NO_ISSUER, requireKyc: false });
    });
  }

  it("treats a buffer that ends one byte short of the KYC fields as an older config", () => {
    assert.deepEqual(decodeKycPolicy(configBytes(1, { issuer: WALLET, requireKyc: true }).subarray(0, 45 + 32 + 32)), {
      issuer: NO_ISSUER,
      requireKyc: false,
    });
  });

  it("returns null for a wrong discriminator and for a buffer too short to hold the mints length", () => {
    const wrong = configBytes(0, { issuer: WALLET, requireKyc: true });
    wrong.set(accountDiscriminator("Attestation"), 0);
    assert.equal(decodeKycPolicy(wrong), null);
    assert.equal(decodeKycPolicy(configBytes(0).subarray(0, 44)), null);
  });
});

describe("isValid", () => {
  const NOW = 1_750_000_000;
  const att = (patch: Partial<AttestationAccount> = {}): AttestationAccount => ({
    wallet: WALLET,
    issuer: OTHER,
    level: 1,
    verifiedAt: NOW - 100,
    expiresAt: NOW + 100,
    revoked: false,
    subjectHash: "00".repeat(32),
    ...patch,
  });
  const policy: KycPolicy = { issuer: OTHER, requireKyc: true };

  it("accepts a live level-1 and level-2 attestation from the configured issuer", () => {
    assert.equal(isValid(att(), policy, NOW, WALLET), true);
    assert.equal(isValid(att({ level: 2 }), policy, NOW, WALLET), true);
  });

  it("rejects no attestation, level 0, and a revoked one", () => {
    assert.equal(isValid(null, policy, NOW, WALLET), false);
    assert.equal(isValid(att({ level: 0 }), policy, NOW, WALLET), false);
    assert.equal(isValid(att({ revoked: true }), policy, NOW, WALLET), false);
  });

  it("treats expiry 0 as never, and rejects an expiry at or before now", () => {
    assert.equal(isValid(att({ expiresAt: 0 }), policy, NOW, WALLET), true);
    assert.equal(isValid(att({ expiresAt: NOW + 1 }), policy, NOW, WALLET), true);
    // `expires_at > now` in the program: the boundary second is already expired.
    assert.equal(isValid(att({ expiresAt: NOW }), policy, NOW, WALLET), false);
    assert.equal(isValid(att({ expiresAt: NOW - 1 }), policy, NOW, WALLET), false);
  });

  it("rejects an attestation signed by an issuer other than the policy's", () => {
    // Rotating the issuer in Config must invalidate everything the old key vouched for.
    assert.equal(isValid(att({ issuer: WALLET }), policy, NOW, WALLET), false);
  });

  it("is false when no policy could be read: with no known issuer nothing can be vouched for", () => {
    assert.equal(isValid(att({ issuer: WALLET }), null, NOW, WALLET), false);
  });

  it("is false when the attestation belongs to a different wallet than the one asked about", () => {
    // The PDA seeds already bind the two; the explicit comparison keeps a mis-addressed read from vouching.
    assert.equal(isValid(att({ wallet: OTHER }), policy, NOW, WALLET), false);
    assert.equal(isValid(att({ wallet: OTHER }), policy, NOW, OTHER), true);
  });
});
