import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createInitializeMint2Instruction,
  createMint,
  createTransferCheckedInstruction,
  getAccount,
  getMintLen,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";
import type { Relstate } from "../target/types/relstate.ts";

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

// Leases are only allowed on a mint the admin has put in the on-chain Config, so the suite
// creates its own mints in before() and allows them: a classic SPL one for the existing flows
// and a Token-2022 one carrying ConfidentialTransferMint for the confidential rent path.
let USDC: anchor.web3.PublicKey;
let USDC_2022: anchor.web3.PublicKey;

// Token-2022 instruction bytes. @solana/spl-token 0.4 knows the ConfidentialTransferMint
// extension type but ships no builder for its instructions, so the two the suite needs are
// encoded by hand: [TokenInstruction, ConfidentialTransferInstruction, ...data].
const CONFIDENTIAL_TRANSFER_EXTENSION = 27;
const CT_INITIALIZE_MINT = 0;
const CT_TRANSFER = 7;

/// A Token-2022 mint with the ConfidentialTransferMint extension: auto-approving new accounts,
/// no auditor key. `InitializeMint` for the extension has to run before the mint itself is
/// initialized, or another party could claim the configuration.
async function createConfidentialMint(
  conn: anchor.web3.Connection,
  payer: anchor.web3.Keypair,
  decimals = 6,
) {
  const mint = Keypair.generate();
  const space = getMintLen([ExtensionType.ConfidentialTransferMint]);

  // InitializeMintData: authority (32) | auto_approve_new_accounts (1) | auditor key (32).
  // All-zero means None, so the auditor is left unset.
  const data = Buffer.alloc(2 + 32 + 1 + 32);
  data[0] = CONFIDENTIAL_TRANSFER_EXTENSION;
  data[1] = CT_INITIALIZE_MINT;
  payer.publicKey.toBuffer().copy(data, 2);
  data[34] = 1; // auto_approve_new_accounts

  const tx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space,
      lamports: await conn.getMinimumBalanceForRentExemption(space),
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    new anchor.web3.TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }],
      data,
    }),
    createInitializeMint2Instruction(
      mint.publicKey, decimals, payer.publicKey, null, TOKEN_2022_PROGRAM_ID
    ),
  );
  await anchor.web3.sendAndConfirmTransaction(conn, tx, [payer, mint], {
    commitment: "confirmed",
  });
  return mint.publicKey;
}

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

  async function balance(ata: anchor.web3.PublicKey, tokenProgram = TOKEN_PROGRAM_ID) {
    return Number((await getAccount(connection, ata, undefined, tokenProgram)).amount);
  }

  const configPda = pda(Buffer.from("config"));

  // Adds or removes a mint from the Config allowlist, as `admin` (the provider wallet is the
  // admin because it claimed the Config in before()).
  const setMintAllowed = (
    mint: anchor.web3.PublicKey,
    allowed: boolean,
    admin?: anchor.web3.Keypair,
  ) => {
    const call = program.methods
      .setMintAllowed(mint, allowed)
      .accountsPartial({ admin: admin?.publicKey ?? provider.wallet.publicKey, config: configPda });
    return (admin ? call.signers([admin]) : call).rpc();
  };

  // The mints and the Config are created once by the provider wallet, which stays mint authority
  // and becomes the Config admin.
  before(async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;
    USDC = await createMint(connection, payer, payer.publicKey, null, 6);
    USDC_2022 = await createConfidentialMint(freshConnection(), payer);

    if (!(await program.account.config.fetchNullable(configPda))) {
      await program.methods
        .initConfig()
        .accountsPartial({ admin: payer.publicKey, config: configPda })
        .rpc();
    }
    await setMintAllowed(USDC, true);
    await setMintAllowed(USDC_2022, true);
  });

  // `returning` = an earlier Env whose tenant (wallet, token account, record) takes another lease
  async function setup(periodSecs = PERIOD, mint = USDC, returning?: { tenant: anchor.web3.Keypair; tenantAta: anchor.web3.PublicKey }, tokenProgram = TOKEN_PROGRAM_ID) {
    const conn = freshConnection();
    const landlord = Keypair.generate();
    const tenant = returning?.tenant ?? Keypair.generate();
    await Promise.all([airdrop(landlord), returning ? null : airdrop(tenant)]);

    const landlordAta = await createAssociatedTokenAccount(
      conn, landlord, mint, landlord.publicKey, undefined, tokenProgram
    );
    const tenantAta = returning?.tenantAta ?? await createAssociatedTokenAccount(
      conn, tenant, mint, tenant.publicKey, undefined, tokenProgram
    );
    const payer = (provider.wallet as anchor.Wallet).payer;
    if (!returning) {
      await mintTo(conn, payer, mint, tenantAta, payer, START_BALANCE, [], undefined, tokenProgram);
    }

    const leaseId = nextLeaseId++;
    const lease = pda(Buffer.from("lease"), landlord.publicKey.toBuffer(), u64(leaseId));
    const vault = pda(Buffer.from("vault"), lease.toBuffer());
    const landlordProfile = pda(Buffer.from("profile"), landlord.publicKey.toBuffer());
    const tenantProfile = pda(Buffer.from("profile"), tenant.publicKey.toBuffer());

    return {
      landlord, tenant, mint, landlordAta, tenantAta, lease, vault,
      landlordProfile, tenantProfile, tokenProgram,

      // overrides let tests try invalid lease terms
      propose: (o: { rent?: number; term?: number; grace?: number; region?: number[]; tenant?: anchor.web3.PublicKey; tenantProfile?: anchor.web3.PublicKey } = {}) =>
        program.methods
          .proposeLease(
            new BN(leaseId), new BN(o.rent ?? RENT), new BN(DEPOSIT), new BN(periodSecs),
            new BN(o.grace ?? GRACE), o.term ?? TERM, LEASE_HASH, o.region ?? REGION
          )
          .accountsPartial({
            landlord: landlord.publicKey, tenant: o.tenant ?? tenant.publicKey,
            mint, lease, vault, landlordProfile, tokenProgram,
            tenantProfile: o.tenantProfile ?? (o.tenant ? pda(Buffer.from("profile"), o.tenant.toBuffer()) : tenantProfile),
          })
          .signers([landlord])
          .rpc(),

      fund: (hash = LEASE_HASH) =>
        program.methods
          .fundDeposit(hash)
          .accountsPartial({
            tenant: tenant.publicKey, lease, mint, vault, tenantAta, tenantProfile,
            tokenProgram,
          })
          .signers([tenant])
          .rpc(),

      pay: () =>
        program.methods
          .payRent()
          .accountsPartial({
            tenant: tenant.publicKey, lease, mint, tenantAta, landlordAta, tenantProfile,
            tokenProgram,
          })
          .signers([tenant])
          .rpc(),

      claim: (signer = tenant) =>
        program.methods
          .claimDeposit()
          .accountsPartial({
            tenant: signer.publicKey, lease, mint, vault,
            tenantAta, landlordAta, tenantProfile, landlordProfile, tokenProgram,
          })
          .signers([signer])
          .rpc(),

      markDefault: (signer = landlord) =>
        program.methods
          .markDefault()
          .accountsPartial({
            landlord: signer.publicKey, lease, mint, vault,
            tenantAta, landlordAta, tenantProfile, tokenProgram,
          })
          .signers([signer])
          .rpc(),

      // `signer` is a parameter so tests can try releasing as the wrong wallet.
      release: (deduction: number, signer = landlord) =>
        program.methods
          .releaseDeposit(new BN(deduction))
          .accountsPartial({
            landlord: signer.publicKey, lease, mint, vault,
            tenantAta, landlordAta, tenantProfile, landlordProfile, tokenProgram,
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

    const second = await setup(PERIOD, USDC, first);
    await second.propose();
    const lease = await program.account.lease.fetch(second.lease);
    expect([lease.depositAmount.toNumber(), lease.discountPct]).to.deep.equal([DEPOSIT / 2, 50]);

    await second.fund();
    expect(await balance(second.vault)).to.equal(DEPOSIT / 2);
  });

  it("the discount only covers rent up to 1.5x the tenant's typical rent", async () => {
    const first = await active();
    await finishLease(first); // typical rent = RENT

    const within = await setup(PERIOD, USDC, first);
    await within.propose({ rent: RENT * 1.5 });
    expect((await program.account.lease.fetch(within.lease)).discountPct).to.equal(50);

    const above = await setup(PERIOD, USDC, first);
    await above.propose({ rent: RENT * 1.5 + 1 });
    expect((await program.account.lease.fetch(above.lease)).discountPct).to.equal(0);
  });

  it("a late payment removes the discount", async () => {
    const first = await active();
    await finishLease(first, true);

    const second = await setup(PERIOD, USDC, first);
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

  async function applicant() {
    const landlord = Keypair.generate();
    const tenant = Keypair.generate();
    await airdrop(tenant);
    const l = await listing(landlord, nextLeaseId++);
    await l.create();
    const application = pda(Buffer.from("application"), l.address.toBuffer(), tenant.publicKey.toBuffer());
    const apply = (who = tenant) =>
      program.methods.apply()
        .accountsPartial({
          tenant: who.publicKey, listing: l.address,
          application: pda(Buffer.from("application"), l.address.toBuffer(), who.publicKey.toBuffer()),
        })
        .signers([who]).rpc();
    const close = (signer: anchor.web3.Keypair) =>
      program.methods.closeApplication()
        .accountsPartial({ signer: signer.publicKey, application, tenant: tenant.publicKey })
        .signers([signer]).rpc();
    return { landlord, tenant, listing: l, application, apply, close };
  }

  it("a tenant applies to a listing and the landlord can find the application", async () => {
    const a = await applicant();
    await a.apply();

    const got = await program.account.application.fetch(a.application);
    expect([got.listing.toBase58(), got.landlord.toBase58(), got.tenant.toBase58()])
      .to.deep.equal([a.listing.address.toBase58(), a.landlord.publicKey.toBase58(), a.tenant.publicKey.toBase58()]);
    // Application layout: 8-byte discriminator, then listing (8), landlord (40), tenant (72)
    const byLandlord = await program.account.application.all([{ memcmp: { offset: 40, bytes: a.landlord.publicKey.toBase58() } }]);
    const byTenant = await program.account.application.all([{ memcmp: { offset: 72, bytes: a.tenant.publicKey.toBase58() } }]);
    expect(byLandlord.length).to.equal(1);
    expect(byTenant.length).to.equal(1);
  });

  it("cannot apply twice, or to your own listing", async () => {
    const a = await applicant();
    await a.apply();
    await expectFail(a.apply());
    await airdrop(a.landlord);
    await expectFail(a.apply(a.landlord), "SelfLease");
  });

  it("either side can close an application, a stranger cannot", async () => {
    const a = await applicant();
    const stranger = Keypair.generate();
    await airdrop(stranger);
    await a.apply();
    await expectFail(a.close(stranger), "NotYourApplication");
    await a.close(a.landlord);
    expect(await connection.getAccountInfo(a.application)).to.equal(null);

    await a.apply();
    await a.close(a.tenant);
    expect(await connection.getAccountInfo(a.application)).to.equal(null);
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

  // ---- config ----

  it("the admin can allow a mint and take it away again", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;
    const extra = await createMint(freshConnection(), payer, payer.publicKey, null, 6);

    const before = await setup(PERIOD, extra);
    await expectFail(before.propose(), "MintNotAllowed");

    await setMintAllowed(extra, true);
    expect((await program.account.config.fetch(configPda)).mints.map(String))
      .to.include(extra.toBase58());
    const allowed = await setup(PERIOD, extra);
    await allowed.propose();

    await setMintAllowed(extra, false);
    expect((await program.account.config.fetch(configPda)).mints.map(String))
      .to.not.include(extra.toBase58());
    const after = await setup(PERIOD, extra);
    await expectFail(after.propose(), "MintNotAllowed");
  });

  it("only the admin can change the allowed mints", async () => {
    const stranger = Keypair.generate();
    await airdrop(stranger);
    await expectFail(setMintAllowed(USDC, false, stranger), "NotAdmin");
    // the list is untouched, so leases on it still work
    expect((await program.account.config.fetch(configPda)).mints.map(String))
      .to.include(USDC.toBase58());
  });

  it("a Token-2022 mint backs a lease and funds the vault", async () => {
    const env = await setup(PERIOD, USDC_2022, undefined, TOKEN_2022_PROGRAM_ID);
    await env.propose();
    await env.fund();

    expect(await balance(env.vault, TOKEN_2022_PROGRAM_ID)).to.equal(DEPOSIT);
    expect(await balance(env.tenantAta, TOKEN_2022_PROGRAM_ID))
      .to.equal(START_BALANCE - DEPOSIT);
    const lease = await program.account.lease.fetch(env.lease);
    expect(lease.mint.toBase58()).to.equal(USDC_2022.toBase58());
    expect(lease.status).to.have.property("active");
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

  // ---- confidential rent ----

  // pay_rent on a confidential mint cannot move tokens itself: the amount is encrypted, so the
  // tenant's confidential Transfer has to sit directly before it and pay_rent only checks its
  // shape. Only the "no confidential transfer" cases are tested on chain. The destination,
  // mint and ordering checks cannot be: a confidential Transfer with a dummy payload fails
  // inside Token-2022, at the instruction before pay_rent, so pay_rent never runs and any
  // assertion about its error would pass for the wrong reason. Those dimensions are covered by
  // the unit tests in `mod tests` in programs/relstate/src/instructions/pay_rent.rs
  // (rejects_a_transfer_to_someone_else, rejects_a_transfer_from_someone_else,
  // rejects_a_transfer_on_another_mint, rejects_another_token_2022_instruction,
  // accepts_a_matching_transfer and the rest), and end to end by the devnet run in the
  // Phase 1 exit gate. Do not add on-chain tests for them without real proofs.

  async function confidentialEnv() {
    const env = await setup(PERIOD, USDC_2022, undefined, TOKEN_2022_PROGRAM_ID);
    await env.propose();
    await env.fund();
    return env;
  }

  it("rejects paying rent on a confidential mint with no transfer in the transaction", async () => {
    const env = await confidentialEnv();
    await expectFail(env.pay(), "MissingConfidentialTransfer");

    // the rejection must leave no bookkeeping behind
    expect((await program.account.lease.fetch(env.lease)).paidCount).to.equal(0);
    const t = await program.account.profile.fetch(env.tenantProfile);
    expect([t.paidOnTime, t.paidLate, t.rentPaidTotal.toNumber()]).to.deep.equal([0, 0, 0]);
  });

  it("rejects a public transfer_checked in place of a confidential transfer", async () => {
    const env = await confidentialEnv();
    // The public transfer succeeds on its own, so this is the real property: a tenant cannot
    // pay in the clear on a confidential mint and still be credited by pay_rent.
    const publicTransfer = createTransferCheckedInstruction(
      env.tenantAta, USDC_2022, env.landlordAta, env.tenant.publicKey, RENT, 6, [], TOKEN_2022_PROGRAM_ID
    );
    const payRent = await program.methods
      .payRent()
      .accountsPartial({
        tenant: env.tenant.publicKey, lease: env.lease, mint: env.mint,
        tenantAta: env.tenantAta, landlordAta: env.landlordAta,
        tenantProfile: env.tenantProfile, tokenProgram: env.tokenProgram,
      })
      .instruction();
    const tx = new anchor.web3.Transaction().add(publicTransfer, payRent);
    await expectFail(
      anchor.web3.sendAndConfirmTransaction(freshConnection(), tx, [env.tenant]),
      "MissingConfidentialTransfer"
    );
    // the whole transaction reverted, including the public transfer
    expect((await program.account.lease.fetch(env.lease)).paidCount).to.equal(0);
    expect(await balance(env.landlordAta, TOKEN_2022_PROGRAM_ID)).to.equal(0);
  });
});
