import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";
import { Relstate } from "../target/types/relstate";

const { Keypair, PublicKey, LAMPORTS_PER_SOL } = anchor.web3;

const RENT = 1_000;
const DEPOSIT = 2_000;
const PERIOD = 100;
const TERM = 3;
const START_BALANCE = 10_000;

describe("relstate", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const { connection } = provider;
  const program = anchor.workspace.relstate as Program<Relstate>;

  // Unique per test, so lease PDAs never collide on a shared validator.
  let nextLeaseId = Date.now();

  const pda = (...seeds: Buffer[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const u64 = (n: number) => new BN(n).toArrayLike(Buffer, "le", 8);

  // Surfpool cheatcode: the surfnet clock does not follow wall-clock time, so lateness
  // has to be simulated by jumping it forward.
  async function timeTravel(secondsAhead: number) {
    const res = await (globalThis as any).fetch(connection.rpcEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "surfnet_timeTravel",
        params: [{ absoluteTimestamp: Date.now() + secondsAhead * 1000 }],
      }),
    });
    const json: any = await res.json();
    if (json.error) throw new Error(JSON.stringify(json.error));
  }

  async function airdrop(kp: anchor.web3.Keypair) {
    const signature = await connection.requestAirdrop(
      kp.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction({
      signature,
      ...(await connection.getLatestBlockhash()),
    });
  }

  async function balance(ata: anchor.web3.PublicKey) {
    return Number((await getAccount(connection, ata)).amount);
  }

  async function setup(periodSecs = PERIOD) {
    const landlord = Keypair.generate();
    const tenant = Keypair.generate();
    await Promise.all([airdrop(landlord), airdrop(tenant)]);

    const mint = await createMint(connection, landlord, landlord.publicKey, null, 6);
    const landlordAta = await createAssociatedTokenAccount(
      connection, landlord, mint, landlord.publicKey
    );
    const tenantAta = await createAssociatedTokenAccount(
      connection, tenant, mint, tenant.publicKey
    );
    await mintTo(connection, landlord, mint, tenantAta, landlord, START_BALANCE);

    const leaseId = nextLeaseId++;
    const lease = pda(Buffer.from("lease"), landlord.publicKey.toBuffer(), u64(leaseId));
    const vault = pda(Buffer.from("vault"), lease.toBuffer());
    const landlordProfile = pda(Buffer.from("profile"), landlord.publicKey.toBuffer());
    const tenantProfile = pda(Buffer.from("profile"), tenant.publicKey.toBuffer());

    return {
      landlord, tenant, mint, landlordAta, tenantAta, lease, vault,
      landlordProfile, tenantProfile,

      create: () =>
        program.methods
          .createLease(
            new BN(leaseId), new BN(RENT), new BN(DEPOSIT), new BN(periodSecs),
            TERM, Array(32).fill(7)
          )
          .accountsPartial({
            landlord: landlord.publicKey, tenant: tenant.publicKey,
            mint, lease, vault, landlordProfile,
          })
          .signers([landlord])
          .rpc(),

      fund: () =>
        program.methods
          .fundDeposit()
          .accountsPartial({
            tenant: tenant.publicKey, lease, mint, vault, tenantAta, tenantProfile,
          })
          .signers([tenant])
          .rpc(),

      pay: () =>
        program.methods
          .payRent()
          .accountsPartial({
            tenant: tenant.publicKey, lease, mint, tenantAta, landlordAta, tenantProfile,
          })
          .signers([tenant])
          .rpc(),

      // `signer` is a parameter so tests can try releasing as the wrong wallet.
      release: (deduction: number, signer = landlord) =>
        program.methods
          .releaseDeposit(new BN(deduction))
          .accountsPartial({
            landlord: signer.publicKey, lease, mint, vault,
            tenantAta, landlordAta, tenantProfile, landlordProfile,
          })
          .signers([signer])
          .rpc(),
    };
  }
  type Env = Awaited<ReturnType<typeof setup>>;

  async function active(periodSecs = PERIOD) {
    const env = await setup(periodSecs);
    await env.create();
    await env.fund();
    return env;
  }

  async function fullyPaid() {
    const env = await active();
    for (let i = 0; i < TERM; i++) await env.pay();
    return env;
  }

  async function expectFail(promise: Promise<unknown>, code?: string) {
    try {
      await promise;
    } catch (e: any) {
      if (code) {
        const text = [e?.error?.errorCode?.code, e?.message, ...(e?.logs ?? [])].join(" ");
        expect(text).to.include(code);
      }
      return;
    }
    expect.fail(`expected the transaction to fail${code ? ` with ${code}` : ""}`);
  }

  it("happy path builds a track record", async () => {
    const env = await fullyPaid();

    // rent went straight to the landlord, deposit sits in the vault
    expect(await balance(env.landlordAta)).to.equal(3 * RENT);
    expect(await balance(env.vault)).to.equal(DEPOSIT);
    expect(await balance(env.tenantAta)).to.equal(START_BALANCE - DEPOSIT - 3 * RENT);

    await env.release(0);

    expect(await balance(env.vault)).to.equal(0);
    expect(await balance(env.tenantAta)).to.equal(START_BALANCE - 3 * RENT);
    expect((await program.account.lease.fetch(env.lease)).status).to.have.property("closed");

    const t = await program.account.profile.fetch(env.tenantProfile);
    expect([t.leasesCompleted, t.paidOnTime, t.paidLate]).to.deep.equal([1, 3, 0]);
    expect([t.depositsReturnedFull, t.depositsWithheld]).to.deep.equal([1, 0]);
    const l = await program.account.profile.fetch(env.landlordProfile);
    expect([l.leasesCompleted, l.depositsReturnedFull]).to.deep.equal([1, 1]);
  });

  it("pays a deduction to the landlord and records it", async () => {
    const env = await fullyPaid();
    await env.release(500);

    expect(await balance(env.tenantAta)).to.equal(START_BALANCE - 3 * RENT - 500);
    expect(await balance(env.landlordAta)).to.equal(3 * RENT + 500);
    const t = await program.account.profile.fetch(env.tenantProfile);
    expect([t.depositsReturnedFull, t.depositsWithheld]).to.deep.equal([0, 1]);
  });

  it("counts a late payment", async () => {
    // first rent is due at start_ts, grace is 10s: jump a minute ahead, then pay.
    const env = await active();
    await timeTravel(60);
    await env.pay();

    const t = await program.account.profile.fetch(env.tenantProfile);
    expect([t.paidOnTime, t.paidLate]).to.deep.equal([0, 1]);
  });

  it("cannot fund twice", async () => {
    const env = await active();
    await expectFail(env.fund(), "WrongStatus");
  });

  it("cannot pay before funding", async () => {
    const env = await setup();
    await env.create();
    // fails before the handler runs: the tenant profile doesn't exist until fund_deposit
    await expectFail(env.pay());
  });

  it("cannot overpay the term", async () => {
    const env = await fullyPaid();
    await expectFail(env.pay(), "TermCompleted");
  });

  it("cannot release before the term is paid", async () => {
    const env = await active();
    await env.pay();
    await expectFail(env.release(0), "TermIncomplete");
  });

  it("cannot deduct more than the deposit", async () => {
    const env = await fullyPaid();
    await expectFail(env.release(DEPOSIT + 1), "DeductionTooLarge");
  });

  it("tenant cannot release the deposit", async () => {
    const env = await fullyPaid();
    await expectFail(env.release(0, env.tenant));
    expect(await balance(env.vault)).to.equal(DEPOSIT);
  });
});
