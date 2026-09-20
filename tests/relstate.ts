import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";
import * as fs from "fs";
import { Relstate } from "../target/types/relstate";

const { Keypair, PublicKey, LAMPORTS_PER_SOL } = anchor.web3;

const RENT = 1_000;
const DEPOSIT = 2_000;
const PERIOD = 100;
const GRACE = 10;
const CLAIM_WINDOW = 10; // CLAIM_WINDOW_SECS in the demo build
const TERM = 3;
const START_BALANCE = 10_000;
const LEASE_HASH = Array(32).fill(7);
const REGION = [80, 76]; // "PL"

// The program only accepts this mint (ALLOWED_MINT in constants.rs).
const MINT_KEYPAIR = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${__dirname}/test-usdc-mint.json`, "utf8")))
);

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

  async function chainNow() {
    const info = await connection.getAccountInfo(anchor.web3.SYSVAR_CLOCK_PUBKEY);
    return Number(info!.data.readBigInt64LE(32)); // Clock.unix_timestamp
  }

  // Surfpool cheatcode: the surfnet clock does not follow wall-clock time, so periods
  // elapsing (or lateness) have to be simulated by jumping it forward from the chain's
  // own clock, which drifts a little with every transaction.
  async function timeTravel(secondsAhead: number) {
    const res = await (globalThis as any).fetch(connection.rpcEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "surfnet_timeTravel",
        params: [{ absoluteTimestamp: ((await chainNow()) + secondsAhead) * 1000 }],
      }),
    });
    const json: any = await res.json();
    if (json.error) throw new Error(JSON.stringify(json.error));
  }

  // web3.js caches a blockhash per Connection for 30s of wall-clock time, but a time
  // jump moves the slot by hundreds and expires it. The spl-token helpers rely on that
  // cache, so they get a fresh Connection each time.
  const freshConnection = () => new anchor.web3.Connection(connection.rpcEndpoint, "confirmed");

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

  // Created once by the provider wallet, which stays the mint authority.
  before(async () => {
    if (await connection.getAccountInfo(MINT_KEYPAIR.publicKey)) return;
    const payer = (provider.wallet as anchor.Wallet).payer;
    await createMint(connection, payer, payer.publicKey, null, 6, MINT_KEYPAIR);
  });

  // `returning` = an earlier Env whose tenant (wallet, token account, record) takes another lease
  async function setup(periodSecs = PERIOD, mint = MINT_KEYPAIR.publicKey, returning?: { tenant: anchor.web3.Keypair; tenantAta: anchor.web3.PublicKey }) {
    const conn = freshConnection();
    const landlord = Keypair.generate();
    const tenant = returning?.tenant ?? Keypair.generate();
    await Promise.all([airdrop(landlord), returning ? null : airdrop(tenant)]);

    const landlordAta = await createAssociatedTokenAccount(
      conn, landlord, mint, landlord.publicKey
    );
    const tenantAta = returning?.tenantAta ?? await createAssociatedTokenAccount(
      conn, tenant, mint, tenant.publicKey
    );
    const payer = (provider.wallet as anchor.Wallet).payer;
    if (!returning) await mintTo(conn, payer, mint, tenantAta, payer, START_BALANCE);

    const leaseId = nextLeaseId++;
    const lease = pda(Buffer.from("lease"), landlord.publicKey.toBuffer(), u64(leaseId));
    const vault = pda(Buffer.from("vault"), lease.toBuffer());
    const landlordProfile = pda(Buffer.from("profile"), landlord.publicKey.toBuffer());
    const tenantProfile = pda(Buffer.from("profile"), tenant.publicKey.toBuffer());

    return {
      landlord, tenant, mint, landlordAta, tenantAta, lease, vault,
      landlordProfile, tenantProfile,

      // overrides let tests try invalid lease terms
      propose: (o: { rent?: number; term?: number; grace?: number; region?: number[]; tenant?: anchor.web3.PublicKey; tenantProfile?: anchor.web3.PublicKey } = {}) =>
        program.methods
          .proposeLease(
            new BN(leaseId), new BN(o.rent ?? RENT), new BN(DEPOSIT), new BN(periodSecs),
            new BN(o.grace ?? GRACE), o.term ?? TERM, LEASE_HASH, o.region ?? REGION
          )
          .accountsPartial({
            landlord: landlord.publicKey, tenant: o.tenant ?? tenant.publicKey,
            mint, lease, vault, landlordProfile,
            tenantProfile: o.tenantProfile ?? (o.tenant ? pda(Buffer.from("profile"), o.tenant.toBuffer()) : tenantProfile),
          })
          .signers([landlord])
          .rpc(),

      fund: (hash = LEASE_HASH) =>
        program.methods
          .fundDeposit(hash)
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

      claim: (signer = tenant) =>
        program.methods
          .claimDeposit()
          .accountsPartial({
            tenant: signer.publicKey, lease, mint, vault,
            tenantAta, landlordAta, tenantProfile, landlordProfile,
          })
          .signers([signer])
          .rpc(),

      markDefault: (signer = landlord) =>
        program.methods
          .markDefault()
          .accountsPartial({
            landlord: signer.publicKey, lease, mint, vault,
            tenantAta, landlordAta, tenantProfile,
          })
          .signers([signer])
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
    await env.propose();
    await env.fund();
    return env;
  }

  // pays every period on its due date; the lease itself has not ended yet
  async function allPaid() {
    const env = await active();
    for (let i = 0; i < TERM; i++) {
      if (i > 0) await timeTravel(PERIOD);
      await env.pay();
    }
    return env;
  }

  // ... and additionally jumps to the end of the term, when the deposit can be released
  async function fullyPaid() {
    const env = await allPaid();
    await timeTravel(PERIOD);
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
    const closed = await program.account.lease.fetch(env.lease);
    expect(closed.status).to.have.property("closed");
    expect(closed.region).to.deep.equal(REGION);
    expect([closed.depositAmount.toNumber(), closed.discountPct]).to.deep.equal([DEPOSIT, 0]); // first lease: no history, no discount

    const t = await program.account.profile.fetch(env.tenantProfile);
    expect([t.leasesCompleted, t.paidOnTime, t.paidLate, t.defaults]).to.deep.equal([1, 3, 0, 0]);
    expect([t.depositsReturnedFull, t.depositTotal.toNumber(), t.deductedTotal.toNumber()])
      .to.deep.equal([1, DEPOSIT, 0]);
    expect(t.rentPaidTotal.toNumber()).to.equal(3 * RENT);
    const l = await program.account.profile.fetch(env.landlordProfile);
    expect([l.leasesCompleted, l.depositsReturnedFull]).to.deep.equal([1, 1]);
  });

  it("pays a deduction to the landlord and records it", async () => {
    const env = await fullyPaid();
    await env.release(500);

    expect(await balance(env.tenantAta)).to.equal(START_BALANCE - 3 * RENT - 500);
    expect(await balance(env.landlordAta)).to.equal(3 * RENT + 500);
    const t = await program.account.profile.fetch(env.tenantProfile);
    expect([t.depositsReturnedFull, t.depositTotal.toNumber(), t.deductedTotal.toNumber()])
      .to.deep.equal([0, DEPOSIT, 500]);
    // the landlord's Profile carries the same facts
    const l = await program.account.profile.fetch(env.landlordProfile);
    expect([l.depositTotal.toNumber(), l.deductedTotal.toNumber()]).to.deep.equal([DEPOSIT, 500]);
  });

  it("counts a late payment", async () => {
    // first rent is due at start_ts and grace is 10s: jump a minute ahead, then pay.
    const env = await active();
    await timeTravel(60);
    await env.pay();

    const t = await program.account.profile.fetch(env.tenantProfile);
    expect([t.paidOnTime, t.paidLate]).to.deep.equal([0, 1]);
  });

  // pays every rent (the first one late when asked), jumps past the term and releases the deposit
  async function finishLease(env: Env, firstLate = false) {
    for (let i = 0; i < TERM; i++) {
      const wait = i === 0 ? (firstLate ? 60 : 0) : PERIOD;
      if (wait) await timeTravel(wait);
      await env.pay();
    }
    await timeTravel(PERIOD);
    await env.release(0);
  }

  it("a tenant with a clean record pays half the deposit on the next lease", async () => {
    const first = await active();
    await finishLease(first);

    const second = await setup(PERIOD, MINT_KEYPAIR.publicKey, first);
    await second.propose();
    const lease = await program.account.lease.fetch(second.lease);
    expect([lease.depositAmount.toNumber(), lease.discountPct]).to.deep.equal([DEPOSIT / 2, 50]);

    await second.fund();
    expect(await balance(second.vault)).to.equal(DEPOSIT / 2);
  });

  it("the discount only covers rent up to 1.5x the tenant's typical rent", async () => {
    const first = await active();
    await finishLease(first); // typical rent = RENT

    const within = await setup(PERIOD, MINT_KEYPAIR.publicKey, first);
    await within.propose({ rent: RENT * 1.5 });
    expect((await program.account.lease.fetch(within.lease)).discountPct).to.equal(50);

    const above = await setup(PERIOD, MINT_KEYPAIR.publicKey, first);
    await above.propose({ rent: RENT * 1.5 + 1 });
    expect((await program.account.lease.fetch(above.lease)).discountPct).to.equal(0);
  });

  it("a late payment removes the discount", async () => {
    const first = await active();
    await finishLease(first, true);

    const second = await setup(PERIOD, MINT_KEYPAIR.publicKey, first);
    await second.propose();
    const lease = await program.account.lease.fetch(second.lease);
    expect([lease.depositAmount.toNumber(), lease.discountPct]).to.deep.equal([DEPOSIT, 0]);
  });

  it("the landlord cannot dodge the discount by passing another record", async () => {
    const env = await setup();
    await expectFail(env.propose({ tenantProfile: env.landlordProfile }), "ConstraintSeeds");
  });

  it("finds a wallet's leases by key offset (the app's profile lookup)", async () => {
    const env = await active();
    // Lease layout: 8-byte discriminator, then landlord (offset 8) and tenant (offset 40)
    const byLandlord = await program.account.lease.all([{ memcmp: { offset: 8, bytes: env.landlord.publicKey.toBase58() } }]);
    const byTenant = await program.account.lease.all([{ memcmp: { offset: 40, bytes: env.tenant.publicKey.toBase58() } }]);
    expect(byLandlord.map((r) => r.publicKey.toBase58())).to.deep.equal([env.lease.toBase58()]);
    expect(byTenant.map((r) => r.publicKey.toBase58())).to.deep.equal([env.lease.toBase58()]);
    expect(String.fromCharCode(...byTenant[0].account.region)).to.equal("PL");
  });

  it("cannot fund twice", async () => {
    const env = await active();
    await expectFail(env.fund(), "WrongStatus");
  });

  it("cannot accept a lease with a different hash", async () => {
    const env = await setup();
    await env.propose();
    await expectFail(env.fund(Array(32).fill(8)), "LeaseHashMismatch");
    await env.fund();
  });

  it("cannot pay before funding", async () => {
    const env = await setup();
    await env.propose();
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

  it("cannot pay a period before it is due", async () => {
    const env = await active();
    await env.pay();
    await expectFail(env.pay(), "TooEarly");
  });

  it("cannot release before the lease term has ended", async () => {
    const env = await allPaid();
    await expectFail(env.release(0), "LeaseNotEnded");
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

  it("rejects a lease with zero rent", async () => {
    const env = await setup();
    await expectFail(env.propose({ rent: 0 }), "ZeroRent");
  });

  it("rejects a lease with zero periods", async () => {
    // would otherwise be "completed" with fund_deposit + release_deposit and no rent
    const env = await setup();
    await expectFail(env.propose({ term: 0 }), "ZeroTerm");
  });

  it("rejects a period below the minimum", async () => {
    const env = await setup(0);
    await expectFail(env.propose(), "PeriodTooShort");
  });

  it("rejects a region that is not two uppercase letters", async () => {
    const env = await setup();
    await expectFail(env.propose({ region: [112, 108] }), "InvalidRegion"); // "pl"
  });

  // ---- listings ----

  async function listing(landlord: anchor.web3.Keypair, id: number) {
    await airdrop(landlord);
    const address = pda(Buffer.from("listing"), landlord.publicKey.toBuffer(), u64(id));
    const create = (o: { rent?: number; region?: number[]; title?: string } = {}) =>
      program.methods
        .createListing(new BN(id), new BN(o.rent ?? RENT), new BN(DEPOSIT), o.region ?? REGION,
          o.title ?? "Sunlit studio", "Kraków", "42 m², fibre", "/listings/a.jpg")
        .accountsPartial({ landlord: landlord.publicKey, listing: address })
        .signers([landlord])
        .rpc();
    return { address, create };
  }

  it("a landlord lists an apartment and can find it", async () => {
    const landlord = Keypair.generate();
    const l = await listing(landlord, nextLeaseId++);
    await l.create();

    const got = await program.account.listing.fetch(l.address);
    expect([got.landlord.toBase58(), got.rentAmount.toNumber(), got.depositAmount.toNumber(), got.title])
      .to.deep.equal([landlord.publicKey.toBase58(), RENT, DEPOSIT, "Sunlit studio"]);
    const mine = await program.account.listing.all([{ memcmp: { offset: 8, bytes: landlord.publicKey.toBase58() } }]);
    expect(mine.map((r) => r.publicKey.toBase58())).to.deep.equal([l.address.toBase58()]);
  });

  it("rejects a listing with zero rent, a bad region or an over-long title", async () => {
    const landlord = Keypair.generate();
    await expectFail((await listing(landlord, nextLeaseId++)).create({ rent: 0 }), "ZeroRent");
    await expectFail((await listing(landlord, nextLeaseId++)).create({ region: [112, 108] }), "InvalidRegion");
    await expectFail((await listing(landlord, nextLeaseId++)).create({ title: "x".repeat(61) }), "TextTooLong");
  });

  it("only the landlord can close a listing, which returns the rent", async () => {
    const landlord = Keypair.generate();
    const other = Keypair.generate();
    await airdrop(other);
    const l = await listing(landlord, nextLeaseId++);
    await l.create();

    await expectFail(
      program.methods.closeListing()
        .accountsPartial({ landlord: other.publicKey, listing: l.address })
        .signers([other]).rpc(),
    );
    await program.methods.closeListing()
      .accountsPartial({ landlord: landlord.publicKey, listing: l.address })
      .signers([landlord]).rpc();
    expect(await connection.getAccountInfo(l.address)).to.equal(null);
  });

  it("rejects a lease with yourself", async () => {
    const env = await setup();
    await expectFail(env.propose({ tenant: env.landlord.publicKey }), "SelfLease");
  });

  it("rejects a mint that is not allowed", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;
    const other = await createMint(freshConnection(), payer, payer.publicKey, null, 6);
    const env = await setup(PERIOD, other);
    await expectFail(env.propose(), "MintNotAllowed");
  });

  it("rejects a grace longer than the period", async () => {
    const env = await setup();
    await expectFail(env.propose({ grace: PERIOD + 1 }), "InvalidGrace");
  });

  // Period k is due at start + k*PERIOD; a default needs the oldest unpaid one to be
  // more than PERIOD + GRACE overdue.
  it("default seizes only the rent owed and returns the rest", async () => {
    const env = await active();
    await env.pay();
    await timeTravel(PERIOD);
    await env.pay(); // periods 0 and 1 paid, period 2 (due at +200) stays unpaid
    await timeTravel(215); // now ~ +315, past 200 + PERIOD + GRACE

    await env.markDefault();

    expect(await balance(env.vault)).to.equal(0);
    expect(await balance(env.landlordAta)).to.equal(2 * RENT + RENT);
    expect(await balance(env.tenantAta)).to.equal(START_BALANCE - 2 * RENT - RENT);
    expect((await program.account.lease.fetch(env.lease)).status).to.have.property("defaulted");
    const t = await program.account.profile.fetch(env.tenantProfile);
    expect([t.defaults, t.leasesCompleted, t.paidOnTime]).to.deep.equal([1, 0, 2]);

    await expectFail(env.pay(), "WrongStatus");
    await expectFail(env.release(0), "WrongStatus");
  });

  it("default seizure is capped at the deposit", async () => {
    const env = await active();
    await timeTravel(215); // all 3 periods due and unpaid: owes 3*RENT > DEPOSIT
    await env.markDefault();

    expect(await balance(env.landlordAta)).to.equal(DEPOSIT);
    expect(await balance(env.tenantAta)).to.equal(START_BALANCE - DEPOSIT);
  });

  it("cannot default before the rent is overdue enough", async () => {
    const env = await active();
    await timeTravel(PERIOD); // first rent is 100s late but the threshold is 110s
    await expectFail(env.markDefault(), "NotInDefault");
  });

  it("cannot default a fully paid lease", async () => {
    const env = await allPaid();
    await timeTravel(500);
    await expectFail(env.markDefault(), "TermCompleted");
  });

  it("tenant cannot declare their own default", async () => {
    const env = await active();
    await timeTravel(215);
    await expectFail(env.markDefault(env.tenant));
    expect(await balance(env.vault)).to.equal(DEPOSIT);
  });

  it("tenant claims the deposit when the landlord never releases it", async () => {
    const env = await fullyPaid();
    await timeTravel(CLAIM_WINDOW + 10);
    await env.claim();

    expect(await balance(env.vault)).to.equal(0);
    expect(await balance(env.tenantAta)).to.equal(START_BALANCE - 3 * RENT);
    expect(await balance(env.landlordAta)).to.equal(3 * RENT);
    expect((await program.account.lease.fetch(env.lease)).status).to.have.property("closed");
    const t = await program.account.profile.fetch(env.tenantProfile);
    expect([t.leasesCompleted, t.depositsReturnedFull, t.depositTotal.toNumber()])
      .to.deep.equal([1, 1, DEPOSIT]);
    const l = await program.account.profile.fetch(env.landlordProfile);
    expect([l.leasesCompleted, l.depositsClaimed]).to.deep.equal([1, 1]);

    await expectFail(env.release(0), "WrongStatus");
  });

  it("cannot claim before the landlord's window has passed", async () => {
    const env = await fullyPaid();
    await expectFail(env.claim(), "ClaimTooEarly");
  });

  it("cannot claim while rent is unpaid", async () => {
    const env = await active();
    await timeTravel(1000);
    await expectFail(env.claim(), "TermIncomplete");
  });

  it("landlord cannot claim the deposit as the tenant", async () => {
    const env = await fullyPaid();
    await timeTravel(CLAIM_WINDOW + 10);
    await expectFail(env.claim(env.landlord));
    expect(await balance(env.vault)).to.equal(DEPOSIT);
  });
});
