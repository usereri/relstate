import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createInitializeDefaultAccountStateInstruction,
  createInitializeMint2Instruction,
  createInitializeNonTransferableMintInstruction,
  createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction,
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

/// A Token-2022 mint with the ConfidentialTransferMint extension: auto-approving new accounts and
/// carrying an auditor ElGamal key, which `set_mint_allowed` requires (a confidential mint with no
/// auditor would make every rent payment undecryptable by the backend). `InitializeMint` for the
/// extension has to run before the mint itself is initialized, or another party could claim the
/// configuration. Pass `auditor = null` to build one with no auditor key, for the rejection test.
async function createConfidentialMint(
  conn: anchor.web3.Connection,
  payer: anchor.web3.Keypair,
  decimals = 6,
  auditor: Buffer | null = payer.publicKey.toBuffer(), // any non-zero 32 bytes: the program only checks it is set
) {
  const mint = Keypair.generate();
  const space = getMintLen([ExtensionType.ConfidentialTransferMint]);

  // InitializeMintData: authority (32) | auto_approve_new_accounts (1) | auditor key (32).
  // All-zero means None, so leaving the auditor bytes unset is exactly the "no auditor" case.
  const data = Buffer.alloc(2 + 32 + 1 + 32);
  data[0] = CONFIDENTIAL_TRANSFER_EXTENSION;
  data[1] = CT_INITIALIZE_MINT;
  payer.publicKey.toBuffer().copy(data, 2);
  data[34] = 1; // auto_approve_new_accounts
  if (auditor) auditor.copy(data, 35);

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

/// A Token-2022 mint carrying the given extensions, built from their initialize instructions.
/// Used to prove `set_mint_allowed` refuses extensions that would break the escrow arithmetic.
/// Extension init must run before the mint itself is initialized.
async function createExtensionMint(
  conn: anchor.web3.Connection,
  payer: anchor.web3.Keypair,
  extensions: ExtensionType[],
  init: (mint: anchor.web3.PublicKey) => anchor.web3.TransactionInstruction[],
  decimals = 6,
  freezeAuthority: anchor.web3.PublicKey | null = null,
) {
  const mint = Keypair.generate();
  const space = getMintLen(extensions);
  const tx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space,
      lamports: await conn.getMinimumBalanceForRentExemption(space),
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    ...init(mint.publicKey),
    createInitializeMint2Instruction(
      mint.publicKey, decimals, payer.publicKey, freezeAuthority, TOKEN_2022_PROGRAM_ID
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

  // The build-dependent windows come from the IDL of the build under test, never mirrored here.
  // the Anchor client camel-cases constant names (the raw IDL file keeps SCREAMING_SNAKE)
  const idlConst = (name: string) => {
    const camel = name.toLowerCase().replace(/_(\w)/g, (_, ch) => ch.toUpperCase());
    const c = program.idl.constants?.find((x) => x.name === name || x.name === camel);
    if (!c) throw new Error(`no ${name} in IDL: ${JSON.stringify(program.idl.constants?.map((x) => x.name))}`);
    return Number(c.value);
  };
  const CLAIM_WINDOW = idlConst("CLAIM_WINDOW_SECS");
  const DISPUTE_WINDOW = idlConst("DISPUTE_WINDOW_SECS");

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
  const attestationPda = (wallet: anchor.web3.PublicKey) =>
    pda(Buffer.from("attestation"), wallet.toBuffer());

  // Adds or removes a mint from the Config allowlist, as `admin` (the provider wallet is the
  // admin because it claimed the Config in before()). The mint is passed as an account so the
  // program can inspect its extensions before allowing it.
  const setMintAllowed = (
    mint: anchor.web3.PublicKey,
    allowed: boolean,
    admin?: anchor.web3.Keypair,
  ) => {
    const call = program.methods
      .setMintAllowed(allowed)
      .accountsPartial({ admin: admin?.publicKey ?? provider.wallet.publicKey, config: configPda, mint });
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

  // ---- D2: the appraiser registry (admin-managed, global -- not per lease) ----

  const appraiserPda = (wallet: anchor.web3.PublicKey) =>
    pda(Buffer.from("appraiser"), wallet.toBuffer());

  type Appraiser = { wallet: anchor.web3.Keypair; pda: anchor.web3.PublicKey; ata: anchor.web3.PublicKey };

  // Registers `wallet` (which may be an existing lease's own landlord or tenant, for the "an
  // appraiser cannot be a party" tests) without creating a token account for it: these callers
  // never reach submit_verdict, which is the only instruction that needs one.
  async function registerAsAppraiser(wallet: anchor.web3.Keypair, fee: number): Promise<Appraiser> {
    const p = appraiserPda(wallet.publicKey);
    await program.methods
      .registerAppraiser(wallet.publicKey, new BN(fee), Array(32).fill(1))
      .accountsPartial({ admin: provider.wallet.publicKey, config: configPda, appraiser: p })
      .rpc();
    return { wallet, pda: p, ata: null as unknown as anchor.web3.PublicKey };
  }

  // A fresh registered, active appraiser with a funded ATA on USDC, for the tests that submit a
  // verdict and collect the fee.
  async function registerAppraiser(fee: number): Promise<Appraiser> {
    const wallet = Keypair.generate();
    await airdrop(wallet);
    const base = await registerAsAppraiser(wallet, fee);
    const ata = await createAssociatedTokenAccount(
      freshConnection(), (provider.wallet as anchor.Wallet).payer, USDC, wallet.publicKey
    );
    return { ...base, ata };
  }

  // fee 50 is well under DEPOSIT/10 = 200 (the per-lease cap); fee 500 is well over it, so the
  // two exercise the cap in both directions (docs/contracts/dispute-mediation.md §6).
  let apprLow: Appraiser;
  let apprHigh: Appraiser;
  let apprDefault: Appraiser;
  let apprSuspended: Appraiser;

  before(async () => {
    apprLow = await registerAppraiser(50);
    apprHigh = await registerAppraiser(500);
    apprDefault = await registerAppraiser(50);
    await program.methods
      .setDefaultAppraiser(true)
      .accountsPartial({ admin: provider.wallet.publicKey, config: configPda, appraiser: apprDefault.pda })
      .rpc();
    apprSuspended = await registerAppraiser(10);
    await program.methods
      .setAppraiserActive(false)
      .accountsPartial({ admin: provider.wallet.publicKey, config: configPda, appraiser: apprSuspended.pda })
      .rpc();
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
    // Exists only while the lease is in Mediation: escalate_to_mediation creates it and every
    // exit closes it (docs/contracts/dispute-mediation.md §3).
    const dispute = pda(Buffer.from("dispute"), lease.toBuffer());

    return {
      landlord, tenant, mint, landlordAta, tenantAta, lease, vault, dispute,
      landlordProfile, tenantProfile, tokenProgram,

      // overrides let tests try invalid lease terms
      propose: (o: { rent?: number; deposit?: number; term?: number; grace?: number; region?: number[]; tenant?: anchor.web3.PublicKey; tenantProfile?: anchor.web3.PublicKey } = {}) =>
        program.methods
          .proposeLease(
            new BN(leaseId), new BN(o.rent ?? RENT), new BN(o.deposit ?? DEPOSIT), new BN(periodSecs),
            new BN(o.grace ?? GRACE), o.term ?? TERM, LEASE_HASH, o.region ?? REGION
          )
          .accountsPartial({
            landlord: landlord.publicKey, tenant: o.tenant ?? tenant.publicKey,
            mint, lease, vault, landlordProfile, tokenProgram,
            config: configPda, attestation: attestationPda(landlord.publicKey),
            tenantProfile: o.tenantProfile ?? (o.tenant ? pda(Buffer.from("profile"), o.tenant.toBuffer()) : tenantProfile),
          })
          .signers([landlord])
          .rpc(),

      fund: (hash = LEASE_HASH) =>
        program.methods
          .fundDeposit(hash)
          .accountsPartial({
            tenant: tenant.publicKey, lease, mint, vault, tenantAta, tenantProfile,
            tokenProgram, config: configPda, attestation: attestationPda(tenant.publicKey),
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
            tenantAta, landlordAta, tenantProfile, landlordProfile, tokenProgram,
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

      // both parties sign; `signers` lets a test leave one out or swap in a stranger.
      // `dispute` is null in Disputed (there is no such account) and the Dispute PDA in Mediation.
      settle: (deduction: number, signers: anchor.web3.Keypair[] = [tenant, landlord], disputeAcc: anchor.web3.PublicKey | null = null) =>
        program.methods
          .settleDispute(new BN(deduction))
          .accountsPartial({
            tenant: tenant.publicKey, landlord: landlord.publicKey, lease, dispute: disputeAcc, mint, vault,
            tenantAta, landlordAta, tenantProfile, landlordProfile, tokenProgram,
          })
          .signers(signers)
          .rpc(),

      accept: (signer = tenant) =>
        program.methods
          .acceptDeduction()
          .accountsPartial({
            tenant: signer.publicKey, lease, mint, vault,
            tenantAta, landlordAta, tenantProfile, landlordProfile, tokenProgram,
          })
          .signers([signer])
          .rpc(),

      abandon: (signer = tenant) =>
        program.methods
          .abandonDispute()
          .accountsPartial({ tenant: signer.publicKey, lease })
          .signers([signer])
          .rpc(),

      // the last-round rejection: same gesture for the tenant, but it opens Mediation (D2)
      escalate: (signer = tenant) =>
        program.methods
          .escalateToMediation()
          .accountsPartial({ tenant: signer.publicKey, lease, dispute })
          .signers([signer])
          .rpc(),

      // D2 mediation. `candidates` is 1 to 3 Appraiser handles for the signer's side; the
      // candidates are accounts, not arguments (docs/contracts/dispute-mediation.md §4).
      proposeAppraisers: (party: anchor.web3.Keypair, candidates: Appraiser[]) =>
        program.methods
          .proposeAppraisers()
          .accountsPartial({
            party: party.publicKey, lease, dispute,
            appraiserOne: candidates[0].pda,
            appraiserTwo: candidates[1]?.pda ?? null,
            appraiserThree: candidates[2]?.pda ?? null,
          })
          .signers([party])
          .rpc(),

      pickAppraiser: (party: anchor.web3.Keypair, appr: Appraiser) =>
        program.methods
          .pickAppraiser()
          .accountsPartial({ party: party.publicKey, lease, dispute, appraiser: appr.pda })
          .signers([party])
          .rpc(),

      bindDefaultAppraiser: (caller: anchor.web3.Keypair, appr: Appraiser = apprDefault) =>
        program.methods
          .bindDefaultAppraiser()
          .accountsPartial({ caller: caller.publicKey, lease, dispute, appraiser: appr.pda })
          .signers([caller])
          .rpc(),

      submitVerdict: (deduction: number, appr: Appraiser = apprLow, signer = appr.wallet) =>
        program.methods
          .submitVerdict(new BN(deduction))
          .accountsPartial({
            appraiser: signer.publicKey, appraiserRecord: appr.pda, lease, dispute, mint, vault,
            tenant: tenant.publicKey, tenantAta, landlordAta, appraiserAta: appr.ata,
            tenantProfile, landlordProfile, tokenProgram,
          })
          .signers([signer])
          .rpc(),

      expireMediation: (signer = tenant) =>
        program.methods
          .expireMediation()
          .accountsPartial({ party: signer.publicKey, lease, dispute, tenant: tenant.publicKey })
          .signers([signer])
          .rpc(),

      finalize: (signer = landlord) =>
        program.methods
          .finalizeDeduction()
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
    await env.release(500); // only a proposal now
    await timeTravel(DISPUTE_WINDOW + 5);
    await env.finalize();

    expect(await balance(env.tenantAta)).to.equal(START_BALANCE - 3 * RENT - 500);
    expect(await balance(env.landlordAta)).to.equal(3 * RENT + 500);
    const t = await program.account.profile.fetch(env.tenantProfile);
    expect([t.depositsReturnedFull, t.depositTotal.toNumber(), t.deductedTotal.toNumber()])
      .to.deep.equal([0, DEPOSIT, 500]);
    // the landlord's Profile carries the same facts
    const l = await program.account.profile.fetch(env.landlordProfile);
    expect([l.depositTotal.toNumber(), l.deductedTotal.toNumber()]).to.deep.equal([DEPOSIT, 500]);
    // A2: 1500 of 2000 came back = 7500 bps, on both records
    expect([t.lastDepositReturnBps, t.depositEvents, l.lastDepositReturnBps, l.depositEvents])
      .to.deep.equal([7500, 1, 7500, 1]);
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

  it("rejects a lease with no deposit, including one a discount rounds to nothing", async () => {
    // a free "full return" would inflate the landlord's deposit_events at zero capital cost
    const env = await setup();
    await expectFail(env.propose({ deposit: 0 }), "ZeroDeposit");

    const first = await active();
    await finishLease(first); // earns the 50% discount
    const second = await setup(PERIOD, USDC, first);
    await expectFail(second.propose({ deposit: 1 }), "ZeroDeposit"); // 1 * 50% rounds down to 0
  });

  it("rejects an absurdly long term", async () => {
    // would leave a funded deposit unreleasable and unclaimable forever
    const env = await setup(2 ** 40); // x3 periods is ~10^5 years
    await expectFail(env.propose(), "TermTooLong");
    const huge = await setup(Number.MAX_SAFE_INTEGER);
    await expectFail(huge.propose(), "TermTooLong");
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
          config: configPda, attestation: attestationPda(who.publicKey),
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

  // ---- allowlist guards the mint itself (findings 3, 4, 6) ----

  it("rejects allowing a confidential mint that carries no auditor key", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;
    const noAuditor = await createConfidentialMint(freshConnection(), payer, 6, null);
    await expectFail(setMintAllowed(noAuditor, true), "ConfidentialMintNeedsAuditor");
    // the suite's own confidential mint does carry an auditor, so it was allowed in before()
    expect((await program.account.config.fetch(configPda)).mints.map(String))
      .to.include(USDC_2022.toBase58());
  });

  it("rejects mints whose extensions would break the escrow or block payouts", async () => {
    const payer = (provider.wallet as anchor.Wallet).payer;
    const conn = () => freshConnection();
    const hookProgram = Keypair.generate().publicKey;

    const cases: [string, () => Promise<anchor.web3.PublicKey>][] = [
      ["TransferFeeConfig", () => createExtensionMint(conn(), payer, [ExtensionType.TransferFeeConfig],
        (m) => [createInitializeTransferFeeConfigInstruction(m, payer.publicKey, payer.publicKey, 100, 1_000_000n, TOKEN_2022_PROGRAM_ID)])],
      ["NonTransferable", () => createExtensionMint(conn(), payer, [ExtensionType.NonTransferable],
        (m) => [createInitializeNonTransferableMintInstruction(m, TOKEN_2022_PROGRAM_ID)])],
      ["PermanentDelegate", () => createExtensionMint(conn(), payer, [ExtensionType.PermanentDelegate],
        (m) => [createInitializePermanentDelegateInstruction(m, payer.publicKey, TOKEN_2022_PROGRAM_ID)])],
      ["TransferHook", () => createExtensionMint(conn(), payer, [ExtensionType.TransferHook],
        (m) => [createInitializeTransferHookInstruction(m, payer.publicKey, hookProgram, TOKEN_2022_PROGRAM_ID)])],
      ["PausableConfig", () => createExtensionMint(conn(), payer, [ExtensionType.PausableConfig],
        (m) => [createInitializePausableConfigInstruction(m, payer.publicKey, TOKEN_2022_PROGRAM_ID)])],
      ["DefaultAccountState(Frozen)", () => createExtensionMint(conn(), payer, [ExtensionType.DefaultAccountState],
        (m) => [createInitializeDefaultAccountStateInstruction(m, AccountState.Frozen, TOKEN_2022_PROGRAM_ID)],
        6, payer.publicKey)],
    ];

    for (const [, build] of cases) {
      const mint = await build();
      await expectFail(setMintAllowed(mint, true), "DisallowedMintExtension");
      expect((await program.account.config.fetch(configPda)).mints.map(String))
        .to.not.include(mint.toBase58());
    }
  });

  it("set_admin refuses to hand the config to the default pubkey", async () => {
    await expectFail(
      program.methods
        .setAdmin(PublicKey.default)
        .accountsPartial({ admin: provider.wallet.publicKey, config: configPda })
        .rpc(),
      "InvalidNewAdmin"
    );
    expect((await program.account.config.fetch(configPda)).admin.toBase58())
      .to.equal(provider.wallet.publicKey.toBase58());
  });

  // ---- KYC attestation ----
  //
  // The Config PDA is shared by the whole suite, so every test that turns `require_kyc` on goes
  // through withKycRequired(), which turns it off again in a `finally` even when an assertion
  // fails. Nothing below relies on test order except the first test, which needs a Config that
  // has never had an issuer.

  const issuer = Keypair.generate();
  let issuerFunded = false;
  const payerKp = () => (provider.wallet as anchor.Wallet).payer;
  const DAY = 86_400;
  const SUBJECT = Array(32).fill(9);

  const setIssuer = (key: anchor.web3.PublicKey, admin?: anchor.web3.Keypair) => {
    const call = program.methods
      .setIssuer(key)
      .accountsPartial({ admin: admin?.publicKey ?? provider.wallet.publicKey, config: configPda });
    return (admin ? call.signers([admin]) : call).rpc();
  };
  const setRequireKyc = (on: boolean, admin?: anchor.web3.Keypair) => {
    const call = program.methods
      .setRequireKyc(on)
      .accountsPartial({ admin: admin?.publicKey ?? provider.wallet.publicKey, config: configPda });
    return (admin ? call.signers([admin]) : call).rpc();
  };

  // Idempotent, so tests do not depend on which one ran first (or on a previous test having
  // rotated the issuer away).
  async function ensureIssuer() {
    if (!issuerFunded) {
      await airdrop(issuer);
      issuerFunded = true;
    }
    const cfg = await program.account.config.fetch(configPda);
    if (cfg.issuer.toBase58() !== issuer.publicKey.toBase58()) await setIssuer(issuer.publicKey);
  }

  async function attest(
    wallet: anchor.web3.PublicKey,
    o: {
      level?: number; expiresAt?: number; subjectHash?: number[];
      issuer?: anchor.web3.Keypair; payer?: anchor.web3.Keypair; omitIssuerSignature?: boolean;
    } = {},
  ) {
    await ensureIssuer();
    const signer = o.issuer ?? issuer;
    const signers: anchor.web3.Keypair[] = [];
    if (!o.omitIssuerSignature) signers.push(signer);
    if (o.payer) signers.push(o.payer);
    return program.methods
      .attest(o.level ?? 1, new BN(o.expiresAt ?? (await chainNow()) + DAY), o.subjectHash ?? SUBJECT)
      .accountsPartial({
        payer: o.payer?.publicKey ?? provider.wallet.publicKey,
        config: configPda, issuer: signer.publicKey, wallet, attestation: attestationPda(wallet),
      })
      .signers(signers)
      .rpc();
  }

  const revoke = (wallet: anchor.web3.PublicKey, signer = issuer) =>
    program.methods
      .revoke()
      .accountsPartial({ config: configPda, issuer: signer.publicKey, wallet, attestation: attestationPda(wallet) })
      .signers([signer])
      .rpc();

  // Runs `body` with the gate on and the suite's issuer configured, and always leaves the gate
  // off and the issuer restored, because the rest of the suite shares this Config.
  async function withKycRequired(body: () => Promise<void>) {
    await ensureIssuer();
    await setRequireKyc(true);
    try {
      await body();
    } finally {
      await setRequireKyc(false);
      await ensureIssuer();
    }
  }

  // Must stay the first KYC test: `before()` leaves no issuer, and once any later test has called
  // set_issuer there is no way back to the zero key (set_issuer refuses it), so this case can
  // only be asserted against a Config that has never had one. A reused validator that already
  // has an issuer would make it unprovable, so then it is skipped rather than weakened.
  it("set_require_kyc(true) is refused while no issuer is set", async function () {
    const cfg = await program.account.config.fetch(configPda);
    if (cfg.issuer.toBase58() !== PublicKey.default.toBase58()) return this.skip();
    await expectFail(setRequireKyc(true), "IssuerNotSet");
    expect((await program.account.config.fetch(configPda)).requireKyc).to.equal(false);
  });

  it("set_issuer rejects the zero key, and only the admin can call it", async () => {
    const stranger = Keypair.generate();
    await airdrop(stranger);
    await expectFail(setIssuer(PublicKey.default), "InvalidIssuer");
    await expectFail(setIssuer(issuer.publicKey, stranger), "NotAdmin");
    await expectFail(setRequireKyc(true, stranger), "NotAdmin");
    expect((await program.account.config.fetch(configPda)).requireKyc).to.equal(false);
    await ensureIssuer();
    expect((await program.account.config.fetch(configPda)).issuer.toBase58())
      .to.equal(issuer.publicKey.toBase58());
  });

  it("attest writes the attestation under the wallet's PDA", async () => {
    const wallet = Keypair.generate().publicKey;
    const expiresAt = (await chainNow()) + DAY;
    await attest(wallet, { level: 1, expiresAt });

    const address = attestationPda(wallet);
    const info = await connection.getAccountInfo(address);
    expect(info!.owner.toBase58()).to.equal(program.programId.toBase58());
    const got = await program.account.attestation.fetch(address);
    expect(got.wallet.toBase58()).to.equal(wallet.toBase58());
    expect(got.issuer.toBase58()).to.equal(issuer.publicKey.toBase58());
    expect(got.level).to.equal(1);
    expect(got.expiresAt.toNumber()).to.equal(expiresAt);
    expect(Math.abs(got.verifiedAt.toNumber() - (await chainNow()))).to.be.lessThan(120);
    expect(got.revoked).to.equal(false);
    expect(Array.from(got.subjectHash)).to.deep.equal(SUBJECT);
  });

  it("attest overwrites an earlier attestation and clears a revocation", async () => {
    const wallet = Keypair.generate().publicKey;
    const first = (await chainNow()) + DAY;
    await attest(wallet, { level: 1, expiresAt: first });
    await revoke(wallet);
    expect((await program.account.attestation.fetch(attestationPda(wallet))).revoked).to.equal(true);

    // a comeback after a revocation is the same instruction as the first verification
    const second = first + DAY;
    const hash = Array(32).fill(5);
    await attest(wallet, { level: 2, expiresAt: second, subjectHash: hash });
    const got = await program.account.attestation.fetch(attestationPda(wallet));
    expect([got.level, got.expiresAt.toNumber(), got.revoked]).to.deep.equal([2, second, false]);
    expect(Array.from(got.subjectHash)).to.deep.equal(hash);
  });

  it("attest signed by a key that is not the configured issuer fails", async () => {
    await ensureIssuer();
    const impostor = Keypair.generate();
    const wallet = Keypair.generate().publicKey;
    // the fee payer is the provider wallet, so this is "a valid payer, wrong authoriser"
    await expectFail(attest(wallet, { issuer: impostor }), "NotIssuer");
    expect(await connection.getAccountInfo(attestationPda(wallet))).to.equal(null);
  });

  it("attest rejects a bad level, an empty subject hash and an expiry in the past", async () => {
    const wallet = Keypair.generate().publicKey;
    await expectFail(attest(wallet, { level: 0 }), "InvalidAttestationLevel");
    await expectFail(attest(wallet, { level: 3 }), "InvalidAttestationLevel");
    await expectFail(attest(wallet, { subjectHash: Array(32).fill(0) }), "InvalidSubjectHash");
    await expectFail(attest(wallet, { expiresAt: (await chainNow()) - 10 }), "AttestationExpiryInPast");
    expect(await connection.getAccountInfo(attestationPda(wallet))).to.equal(null);
  });

  it("revoke marks the attestation revoked, is idempotent and is issuer-only", async () => {
    const wallet = Keypair.generate().publicKey;
    await attest(wallet);
    await expectFail(revoke(wallet, Keypair.generate()), "NotIssuer");
    expect((await program.account.attestation.fetch(attestationPda(wallet))).revoked).to.equal(false);

    await revoke(wallet);
    // a repeated vendor "rejected" event must be harmless
    await revoke(wallet);
    expect((await program.account.attestation.fetch(attestationPda(wallet))).revoked).to.equal(true);
  });

  it("the fee payer pays the rent but cannot attest without the issuer's signature", async () => {
    await ensureIssuer();
    const sponsor = Keypair.generate();
    await airdrop(sponsor);
    const wallet = Keypair.generate().publicKey;

    // the sponsor key signing alone must not be able to vouch for anyone
    await expectFail(attest(wallet, { payer: sponsor, omitIssuerSignature: true }));
    expect(await connection.getAccountInfo(attestationPda(wallet))).to.equal(null);

    const before = await connection.getBalance(sponsor.publicKey);
    const issuerBefore = await connection.getBalance(issuer.publicKey);
    await attest(wallet, { payer: sponsor });
    const size = (await connection.getAccountInfo(attestationPda(wallet)))!.data.length;
    const rent = await connection.getMinimumBalanceForRentExemption(size);
    expect(before - (await connection.getBalance(sponsor.publicKey))).to.be.at.least(rent);
    expect(await connection.getBalance(issuer.publicKey)).to.equal(issuerBefore);
  });

  it("with the gate on, apply needs a current attestation from the current issuer", async () => {
    await withKycRequired(async () => {
      // unverified
      const unverified = await applicant();
      await expectFail(unverified.apply(), "KycRequired");

      // verified
      const verified = await applicant();
      await attest(verified.tenant.publicKey);
      await verified.apply();
      await program.account.application.fetch(verified.application);

      // revoked
      const revoked = await applicant();
      await attest(revoked.tenant.publicKey);
      await revoke(revoked.tenant.publicKey);
      await expectFail(revoked.apply(), "KycRequired");

      // expired: the instant has to pass on the chain's own clock
      const expired = await applicant();
      await attest(expired.tenant.publicKey, { expiresAt: (await chainNow()) + 30 });
      await timeTravel(60);
      await expectFail(expired.apply(), "KycRequired");

      // attested by an issuer that has since been rotated out
      const rotated = await applicant();
      await attest(rotated.tenant.publicKey);
      await setIssuer(Keypair.generate().publicKey);
      await expectFail(rotated.apply(), "KycRequired");
    });
    expect((await program.account.config.fetch(configPda)).requireKyc).to.equal(false);
  });

  it("with the gate on, propose_lease verifies the landlord and not the tenant", async () => {
    await withKycRequired(async () => {
      const env = await setup();
      await expectFail(env.propose(), "KycRequired");

      // Only the landlord is attested; the tenant is not. propose_lease deliberately does not
      // ask about the tenant: a lease can be proposed to someone who never applied, and the
      // binding tenant gate is fund_deposit (next test).
      await attest(env.landlord.publicKey);
      expect(await connection.getAccountInfo(attestationPda(env.tenant.publicKey))).to.equal(null);
      await env.propose();
      await program.account.lease.fetch(env.lease);
    });
  });

  it("with the gate on, an unverified tenant cannot fund_deposit; a verified one can", async () => {
    await withKycRequired(async () => {
      const env = await setup();
      await attest(env.landlord.publicKey);
      await env.propose();

      // A verified landlord proposed to a tenant who never applied and was never verified.
      await expectFail(env.fund(), "KycRequired");
      expect((await program.account.lease.fetch(env.lease)).status).to.have.property("proposed");

      await attest(env.tenant.publicKey);
      await env.fund();
      expect((await program.account.lease.fetch(env.lease)).status).to.have.property("active");
    });
  });

  it("with the gate off, apply and propose_lease work without any attestation", async () => {
    expect((await program.account.config.fetch(configPda)).requireKyc).to.equal(false);
    const a = await applicant();
    await a.apply();
    const env = await setup();
    await env.propose();
    expect(await connection.getAccountInfo(attestationPda(a.tenant.publicKey))).to.equal(null);
    expect(await connection.getAccountInfo(attestationPda(env.landlord.publicKey))).to.equal(null);
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

  // ---- A1/A2: deposit-return reputation ----

  it("default seizure is recorded on the landlord's profile (A1)", async () => {
    const env = await active();
    await env.pay();
    await timeTravel(PERIOD);
    await env.pay();
    await timeTravel(215);
    await env.markDefault(); // seizes one period of rent: 1000 of 2000

    const l = await program.account.profile.fetch(env.landlordProfile);
    expect([l.depositTotal.toNumber(), l.deductedTotal.toNumber()]).to.deep.equal([DEPOSIT, RENT]);
    expect([l.lastDepositReturnBps, l.depositEvents]).to.deep.equal([5000, 1]);
    // a default is not a completed lease and not a voluntary full return
    expect([l.leasesCompleted, l.depositsReturnedFull]).to.deep.equal([0, 0]);
    // the tenant's own deposit record is untouched by a default
    const t = await program.account.profile.fetch(env.tenantProfile);
    expect([t.depositEvents, t.depositTotal.toNumber()]).to.deep.equal([0, 0]);
  });

  it("a seizure of the whole deposit reads as a 0% return", async () => {
    const env = await active();
    await timeTravel(215); // 3*RENT owed, capped at the deposit
    await env.markDefault();
    const l = await program.account.profile.fetch(env.landlordProfile);
    expect([l.deductedTotal.toNumber(), l.lastDepositReturnBps]).to.deep.equal([DEPOSIT, 0]);
  });

  it("an instant full release records 10000 bps on both profiles (A2)", async () => {
    const env = await fullyPaid();
    await env.release(0);
    for (const profile of [env.tenantProfile, env.landlordProfile]) {
      const p = await program.account.profile.fetch(profile);
      expect([p.lastDepositReturnBps, p.depositEvents, p.depositsReturnedFull]).to.deep.equal([10000, 1, 1]);
    }
  });

  it("a claimed deposit is 10000 bps but still counts against the landlord (A2)", async () => {
    const env = await fullyPaid();
    await timeTravel(CLAIM_WINDOW + 10);
    await env.claim();
    const l = await program.account.profile.fetch(env.landlordProfile);
    expect([l.lastDepositReturnBps, l.depositEvents, l.depositsClaimed, l.depositsReturnedFull])
      .to.deep.equal([10000, 1, 1, 0]);
    const t = await program.account.profile.fetch(env.tenantProfile);
    expect([t.lastDepositReturnBps, t.depositEvents, t.depositTotal.toNumber(), t.deductedTotal.toNumber()])
      .to.deep.equal([10000, 1, DEPOSIT, 0]);
  });

  // ---- D1: Disputed and settlement ----

  // vault + both wallets always add up: nothing is created or lost by any exit
  async function expectConserved(env: Env, tenantGets: number, landlordGets: number) {
    expect(await balance(env.vault)).to.equal(0);
    expect(await balance(env.tenantAta)).to.equal(START_BALANCE - 3 * RENT - DEPOSIT + tenantGets);
    expect(await balance(env.landlordAta)).to.equal(3 * RENT + landlordGets);
    expect(tenantGets + landlordGets).to.equal(DEPOSIT);
  }

  async function disputed(deduction = 500) {
    const env = await fullyPaid();
    await env.release(deduction);
    return env;
  }

  it("a deduction opens a dispute and pays nothing", async () => {
    const env = await disputed(500);
    const lease = await program.account.lease.fetch(env.lease);
    expect(lease.status).to.have.property("disputed");
    expect(lease.proposedDeduction.toNumber()).to.equal(500);
    expect(lease.disputedAt.toNumber()).to.be.greaterThan(0);
    expect(await balance(env.vault)).to.equal(DEPOSIT);
    expect(await balance(env.tenantAta)).to.equal(START_BALANCE - 3 * RENT - DEPOSIT);
    expect(await balance(env.landlordAta)).to.equal(3 * RENT);
    // no reputation moves until money does
    const l = await program.account.profile.fetch(env.landlordProfile);
    expect([l.depositEvents, l.depositTotal.toNumber(), l.leasesCompleted]).to.deep.equal([0, 0, 0]);
  });

  it("a zero deduction still releases instantly", async () => {
    const env = await fullyPaid();
    await env.release(0);
    expect((await program.account.lease.fetch(env.lease)).status).to.have.property("closed");
    await expectConserved(env, DEPOSIT, 0);
  });

  it("a dispute cannot be opened twice or released over", async () => {
    const env = await disputed(500);
    await expectFail(env.release(300), "WrongStatus");
    await expectFail(env.release(0), "WrongStatus");
    expect((await program.account.lease.fetch(env.lease)).proposedDeduction.toNumber()).to.equal(500);
  });

  it("no one can default a disputed lease or claim while it is disputed", async () => {
    const env = await disputed(500);
    await expectFail(env.markDefault(), "WrongStatus");
    // even long after the claim window would have lapsed: the clock is paused, not running out
    await timeTravel(CLAIM_WINDOW + DISPUTE_WINDOW + 50);
    await expectFail(env.claim(), "WrongStatus");
    expect(await balance(env.vault)).to.equal(DEPOSIT);
  });

  it("both signatures settle at any amount up to the deposit", async () => {
    const env = await disputed(500);
    await env.settle(1200); // neither side's number: the negotiated middle
    await expectConserved(env, DEPOSIT - 1200, 1200);
    expect((await program.account.lease.fetch(env.lease)).status).to.have.property("closed");
    const l = await program.account.profile.fetch(env.landlordProfile);
    const t = await program.account.profile.fetch(env.tenantProfile);
    for (const p of [l, t]) {
      expect([p.depositTotal.toNumber(), p.deductedTotal.toNumber(), p.lastDepositReturnBps, p.depositEvents, p.leasesCompleted])
        .to.deep.equal([DEPOSIT, 1200, 4000, 1, 1]);
      expect(p.depositsReturnedFull).to.equal(0);
    }
  });

  it("settling at zero credits a full return", async () => {
    const env = await disputed(500);
    await env.settle(0);
    await expectConserved(env, DEPOSIT, 0);
    expect((await program.account.profile.fetch(env.landlordProfile)).depositsReturnedFull).to.equal(1);
  });

  it("settle_dispute needs both signatures", async () => {
    const env = await disputed(500);
    await expectFail(env.settle(500, [env.tenant]));
    await expectFail(env.settle(500, [env.landlord]));
    const stranger = Keypair.generate();
    await airdrop(stranger);
    await expectFail(env.settle(500, [env.landlord, stranger]));
    expect(await balance(env.vault)).to.equal(DEPOSIT);
    expect((await program.account.lease.fetch(env.lease)).status).to.have.property("disputed");
  });

  it("settle_dispute refuses more than the deposit", async () => {
    const env = await disputed(500);
    await expectFail(env.settle(DEPOSIT + 1), "DeductionTooLarge");
    expect(await balance(env.vault)).to.equal(DEPOSIT);
  });

  it("settle_dispute only works on a disputed lease", async () => {
    const active = await fullyPaid();
    await expectFail(active.settle(0), "WrongStatus");

    const closed = await disputed(500);
    await closed.settle(500);
    await expectFail(closed.settle(500), "WrongStatus");
    await expectFail(closed.accept(), "WrongStatus");
    await expectFail(closed.abandon(), "WrongStatus");
    await expectFail(closed.finalize(), "WrongStatus");
  });

  it("the tenant accepts the proposal as it stands, and only the tenant can", async () => {
    const env = await disputed(500);
    await expectFail(env.accept(env.landlord), "ConstraintHasOne");
    await env.accept();
    await expectConserved(env, DEPOSIT - 500, 500);
    const l = await program.account.profile.fetch(env.landlordProfile);
    expect([l.deductedTotal.toNumber(), l.lastDepositReturnBps]).to.deep.equal([500, 7500]);
    await expectFail(env.accept(), "WrongStatus");
  });

  it("accept still works after the window: it equals the landlord's own proposal", async () => {
    // If accept expired with the window, a landlord who proposed and vanished would strand the
    // deposit; instead both exits stay open and neither needs the other party.
    const env = await disputed(500);
    await timeTravel(DISPUTE_WINDOW + 20);
    await env.accept();
    await expectConserved(env, DEPOSIT - 500, 500);
  });

  it("the tenant rejects: the proposal is void and the deposit returns in full by claim", async () => {
    const env = await disputed(800);
    await env.abandon();
    const lease = await program.account.lease.fetch(env.lease);
    expect(lease.status).to.have.property("active");
    expect([lease.proposedDeduction.toNumber(), lease.disputedAt.toNumber(), lease.disputeRounds])
      .to.deep.equal([0, 0, 1]);
    expect(lease.claimPauseSecs.toNumber()).to.be.at.most(DISPUTE_WINDOW);
    expect(await balance(env.vault)).to.equal(DEPOSIT);

    await timeTravel(CLAIM_WINDOW + 10);
    await env.claim();
    await expectConserved(env, DEPOSIT, 0);
  });

  it("rejecting resumes the claim clock rather than restarting or skipping it", async () => {
    const env = await fullyPaid();
    await timeTravel(CLAIM_WINDOW + 5); // the claim window has already lapsed
    await env.release(800);
    await expectFail(env.claim(), "WrongStatus"); // paused while disputed
    const spent = Math.max(1, DISPUTE_WINDOW - 3); // strictly inside the window, whatever its length
    await timeTravel(spent);
    await env.abandon();
    // the time spent disputed was added back, so the tenant waits no longer than before the
    // proposal and no shorter than the paused seconds allow
    const lease = await program.account.lease.fetch(env.lease);
    expect(lease.claimPauseSecs.toNumber()).to.be.at.least(spent);
    // and no longer: the single stretch counted twice would be at least 2 * spent, and the
    // timeTravel below adapts to whatever pause it finds, so only this bound catches it
    expect(lease.claimPauseSecs.toNumber()).to.be.below(2 * spent);
    await timeTravel(lease.claimPauseSecs.toNumber() + CLAIM_WINDOW);
    await env.claim();
    await expectConserved(env, DEPOSIT, 0);
  });

  // D2 changed this rule: a rejection no longer ends the argument, it spends one of
  // MAX_DISPUTE_ROUNDS. The round the rounds actually run out on is covered by the mediation
  // suite, which has to escalate and expire to get a lease back to Active at the cap.
  it("a rejection spends a round rather than barring every further proposal", async () => {
    const env = await disputed(800);
    await env.abandon();
    expect((await program.account.lease.fetch(env.lease)).disputeRounds).to.equal(1);

    // the landlord may propose once more, which D1 refused
    await env.release(100);
    const lease = await program.account.lease.fetch(env.lease);
    expect(lease.status).to.have.property("disputed");
    expect(lease.proposedDeduction.toNumber()).to.equal(100);
    expect(await balance(env.vault)).to.equal(DEPOSIT);

    // but the second rejection is escalate_to_mediation, not abandon_dispute: the two cover every
    // round exactly once, so the escalation can be neither skipped nor repeated
    await expectFail(env.abandon(), "WrongDisputeRound");
    await env.accept();
    await expectConserved(env, DEPOSIT - 100, 100);
  });

  it("a full release still works at every round", async () => {
    const env = await disputed(800);
    await env.abandon();
    await env.release(0);
    await expectConserved(env, DEPOSIT, 0);
  });

  it("only the tenant can reject, and only inside the window", async () => {
    const env = await disputed(800);
    await expectFail(env.abandon(env.landlord), "ConstraintHasOne");

    await timeTravel(DISPUTE_WINDOW + 5);
    await expectFail(env.abandon(), "DisputeWindowClosed");
    expect((await program.account.lease.fetch(env.lease)).status).to.have.property("disputed");

    const active = await fullyPaid();
    await expectFail(active.abandon(), "WrongStatus");
  });

  it("the landlord cannot finalize while the tenant's window is open", async () => {
    const env = await disputed(500);
    await expectFail(env.finalize(), "DisputeWindowOpen");
    expect(await balance(env.vault)).to.equal(DEPOSIT);
  });

  it("a silent tenant lets the proposal stand: the landlord finalizes, once", async () => {
    const env = await disputed(500);
    await timeTravel(DISPUTE_WINDOW + 5);
    await env.finalize();
    await expectConserved(env, DEPOSIT - 500, 500);
    await expectFail(env.finalize(), "WrongStatus");
    await expectFail(env.claim(), "WrongStatus");
  });

  it("only the landlord can finalize", async () => {
    const env = await disputed(500);
    await timeTravel(DISPUTE_WINDOW + 5);
    await expectFail(env.finalize(env.tenant), "ConstraintSeeds"); // lease PDA is derived from the signer
    expect(await balance(env.vault)).to.equal(DEPOSIT);
  });

  it("an active lease cannot be finalized or accepted", async () => {
    const env = await fullyPaid();
    await expectFail(env.finalize(), "WrongStatus");
    await expectFail(env.accept(), "WrongStatus");
  });

  // ---- D2: appraiser arbitration (Status::Mediation) ----
  // docs/contracts/dispute-mediation.md; the invariants are listed in §11.

  const SELECTION_WINDOW = idlConst("SELECTION_WINDOW_SECS");
  const VERDICT_WINDOW = idlConst("VERDICT_WINDOW_SECS");

  // disputed(d) -> abandon() -> release(d) -> escalate(): the two-round ladder to Status::Mediation.
  async function mediating(d1 = 500, d2 = 100) {
    const env = await disputed(d1);
    await env.abandon();
    await env.release(d2);
    await env.escalate();
    return env;
  }

  // Runs a verdict and checks the three-way split drains the vault exactly. The appraiser
  // registry entries are shared across the whole suite, so their ATA balance is checked as a
  // delta against what it held just before this verdict, not an absolute number.
  async function expectVerdict(
    env: Env, appr: Appraiser, deduction: number, toTenant: number, toLandlord: number, fee: number,
  ) {
    expect(toTenant + toLandlord + fee).to.equal(DEPOSIT, "the three shares must add up to the deposit");
    const apprBefore = await balance(appr.ata);
    await env.submitVerdict(deduction, appr);
    expect(await balance(env.vault)).to.equal(0);
    expect(await balance(env.tenantAta)).to.equal(START_BALANCE - 3 * RENT - DEPOSIT + toTenant);
    expect(await balance(env.landlordAta)).to.equal(3 * RENT + toLandlord);
    expect(await balance(appr.ata)).to.equal(apprBefore + fee);
  }

  const SYSTEM_PROGRAM = anchor.web3.SystemProgram.programId; // Pubkey::default(): both are 32 zero bytes

  it("escalate_to_mediation opens the Dispute with both deadlines set up front", async () => {
    const env = await disputed(800);
    await env.abandon();
    await env.release(100);
    const before = await chainNow();
    await env.escalate();

    const lease = await program.account.lease.fetch(env.lease);
    expect(lease.status).to.have.property("mediation");
    expect(lease.disputeRounds).to.equal(2);

    const dispute = await program.account.dispute.fetch(env.dispute);
    expect(dispute.selectionDeadline.toNumber()).to.be.closeTo(before + SELECTION_WINDOW, 3);
    expect(dispute.verdictDeadline.toNumber()).to.equal(
      dispute.selectionDeadline.toNumber() + VERDICT_WINDOW
    );
    expect(dispute.appraiser.toBase58()).to.equal(SYSTEM_PROGRAM.toBase58());
  });

  // ---- D2 invariant 2: no stuck state in Mediation (docs §2's table) ----

  it("no stuck state: a stranger can bind the registry's default appraiser after the selection window", async () => {
    const env = await mediating();
    await timeTravel(SELECTION_WINDOW + 5);
    const stranger = Keypair.generate();
    await airdrop(stranger);
    await env.bindDefaultAppraiser(stranger);
    const dispute = await program.account.dispute.fetch(env.dispute);
    expect(dispute.appraiser.toBase58()).to.equal(apprDefault.wallet.publicKey.toBase58());
  });

  it("no stuck state: expire_mediation works even if no appraiser was ever bound", async () => {
    const env = await mediating();
    await timeTravel(SELECTION_WINDOW + VERDICT_WINDOW + 5);
    await env.expireMediation(env.tenant);
    const lease = await program.account.lease.fetch(env.lease);
    expect(lease.status).to.have.property("active");
    expect(await program.account.dispute.fetchNullable(env.dispute)).to.be.null;
  });

  it("no stuck state: settle_dispute closes a Mediation at any point", async () => {
    const env = await mediating();
    await env.settle(300, [env.tenant, env.landlord], env.dispute);
    await expectConserved(env, DEPOSIT - 300, 300);
    expect(await program.account.dispute.fetchNullable(env.dispute)).to.be.null;
  });

  it("settle_dispute in Mediation needs its Dispute account", async () => {
    const env = await mediating();
    await expectFail(env.settle(100, [env.tenant, env.landlord], null), "DisputeAccountRequired");
  });

  // UnexpectedDisputeAccount is defense in depth that the state machine itself cannot reach in
  // this test: the only Dispute PDA that could ever match a Disputed lease's own seeds is one
  // that lease's own escalate_to_mediation would create, and that call also flips the lease to
  // Mediation in the same instruction. So a lease can never be Disputed while its own Dispute
  // account exists; passing another lease's Dispute fails the PDA derivation itself
  // (ConstraintSeeds, since the seeds are [DISPUTE_SEED, lease.key()] for *this* lease) before
  // the handler's status/account match is ever reached.
  it("a Disputed lease cannot be settled with another lease's Dispute account", async () => {
    const stillDisputed = await disputed(100);
    const other = await mediating(); // a real, existing Dispute PDA, just not this lease's
    await expectFail(
      stillDisputed.settle(100, [stillDisputed.tenant, stillDisputed.landlord], other.dispute),
      "ConstraintSeeds"
    );
  });

  // ---- D2 invariant 4: round limits ----

  it("abandon_dispute refuses the last round: that rejection is escalate_to_mediation's job", async () => {
    const env = await disputed(800);
    await env.abandon();
    await env.release(100); // round 2 proposal
    await expectFail(env.abandon(), "WrongDisputeRound");
  });

  it("escalate_to_mediation refuses a round that is not the last one", async () => {
    const env = await disputed(800); // round 1, nothing rejected yet
    await expectFail(env.escalate(), "WrongDisputeRound");
  });

  it("after expire_mediation the round cap still blocks a deduction, but a full release still works", async () => {
    const env = await mediating();
    await timeTravel(SELECTION_WINDOW + VERDICT_WINDOW + 5);
    await env.expireMediation();
    await expectFail(env.release(100), "DisputeRoundsExhausted");
    await env.release(0);
    await expectConserved(env, DEPOSIT, 0);
  });

  it("dispute_rounds never decrements across round 1, round 2, mediation and expiry", async () => {
    const env = await disputed(800);
    expect((await program.account.lease.fetch(env.lease)).disputeRounds).to.equal(0);
    await env.abandon();
    expect((await program.account.lease.fetch(env.lease)).disputeRounds).to.equal(1);
    await env.release(100);
    expect((await program.account.lease.fetch(env.lease)).disputeRounds).to.equal(1);
    await env.escalate();
    expect((await program.account.lease.fetch(env.lease)).disputeRounds).to.equal(2);
    await timeTravel(SELECTION_WINDOW + VERDICT_WINDOW + 5);
    await env.expireMediation();
    expect((await program.account.lease.fetch(env.lease)).disputeRounds).to.equal(2);
  });

  // ---- candidates and picking ----

  it("one side nominates one to three registered, active candidates", async () => {
    const env = await mediating();
    await env.proposeAppraisers(env.landlord, [apprLow, apprHigh]);
    const dispute = await program.account.dispute.fetch(env.dispute);
    expect(dispute.landlordCount).to.equal(2);
    expect(dispute.landlordCandidates.slice(0, 2).map((k: anchor.web3.PublicKey) => k.toBase58()))
      .to.deep.equal([apprLow.wallet.publicKey.toBase58(), apprHigh.wallet.publicKey.toBase58()]);
  });

  it("a side cannot propose twice", async () => {
    const env = await mediating();
    await env.proposeAppraisers(env.landlord, [apprLow]);
    await expectFail(env.proposeAppraisers(env.landlord, [apprHigh]), "CandidatesAlreadyProposed");
  });

  it("the same appraiser twice in one side's list is refused", async () => {
    const env = await mediating();
    await expectFail(env.proposeAppraisers(env.landlord, [apprLow, apprLow]), "DuplicateCandidate");
  });

  it("an unregistered key cannot be a candidate", async () => {
    const env = await mediating();
    const ghostWallet = Keypair.generate();
    const ghost: Appraiser = { wallet: ghostWallet, pda: appraiserPda(ghostWallet.publicKey), ata: apprLow.ata };
    await expectFail(env.proposeAppraisers(env.landlord, [ghost]), "AccountNotInitialized");
  });

  it("a suspended appraiser is refused as a candidate, and re-checked at pick time", async () => {
    const env = await mediating();
    await expectFail(env.proposeAppraisers(env.landlord, [apprSuspended]), "AppraiserInactive");

    // nominated while still active, then suspended: the pick-time re-check (not just the one at
    // nomination) is what catches an appraiser suspended after the nomination but before anyone
    // picked them, so they do not slip through to the verdict instead.
    const toSuspend = await registerAppraiser(10);
    await env.proposeAppraisers(env.tenant, [toSuspend]);
    await program.methods
      .setAppraiserActive(false)
      .accountsPartial({ admin: provider.wallet.publicKey, config: configPda, appraiser: toSuspend.pda })
      .rpc();
    await expectFail(env.pickAppraiser(env.landlord, toSuspend), "AppraiserInactive");
  });

  it("a party to the lease cannot be nominated, picked or bound as the appraiser", async () => {
    const env = await mediating();
    const landlordAsAppraiser = await registerAsAppraiser(env.landlord, 10);
    await program.methods
      .setDefaultAppraiser(true)
      .accountsPartial({ admin: provider.wallet.publicKey, config: configPda, appraiser: landlordAsAppraiser.pda })
      .rpc();

    await expectFail(env.proposeAppraisers(env.tenant, [landlordAsAppraiser]), "NotMediationParty");

    await env.proposeAppraisers(env.tenant, [apprLow]);
    await expectFail(env.pickAppraiser(env.landlord, landlordAsAppraiser), "NotMediationParty");

    await timeTravel(SELECTION_WINDOW + 5);
    await expectFail(env.bindDefaultAppraiser(env.tenant, landlordAsAppraiser), "NotMediationParty");
  });

  it("picking the other side's candidate is how the two converge, and it binds", async () => {
    const env = await mediating();
    await env.proposeAppraisers(env.landlord, [apprLow]);
    await env.proposeAppraisers(env.tenant, [apprHigh]);
    await env.pickAppraiser(env.landlord, apprLow); // its own candidate first
    await env.pickAppraiser(env.tenant, apprLow); // picks the landlord's: converges and binds

    const dispute = await program.account.dispute.fetch(env.dispute);
    expect(dispute.appraiser.toBase58()).to.equal(apprLow.wallet.publicKey.toBase58());
    expect(dispute.verdictDeadline.toNumber()).to.be.greaterThan(0);
  });

  it("a side may change its pick as long as nothing is bound", async () => {
    const env = await mediating();
    await env.proposeAppraisers(env.landlord, [apprLow, apprHigh]);
    await env.pickAppraiser(env.landlord, apprLow);
    await env.pickAppraiser(env.landlord, apprHigh); // changes its mind
    const dispute = await program.account.dispute.fetch(env.dispute);
    expect(dispute.landlordPick.toBase58()).to.equal(apprHigh.wallet.publicKey.toBase58());
    expect(dispute.appraiser.toBase58()).to.equal(SYSTEM_PROGRAM.toBase58());
  });

  it("picking an appraiser neither side proposed is refused", async () => {
    const env = await mediating();
    await expectFail(env.pickAppraiser(env.landlord, apprLow), "CandidateNotProposed");
  });

  it("bind_default_appraiser refuses before the selection window ends", async () => {
    const env = await mediating();
    await expectFail(env.bindDefaultAppraiser(env.tenant), "SelectionWindowOpen");
  });

  it("bind_default_appraiser refuses an entry that is not flagged default", async () => {
    const env = await mediating();
    await timeTravel(SELECTION_WINDOW + 5);
    await expectFail(env.bindDefaultAppraiser(env.tenant, apprLow), "AppraiserNotDefault");
  });

  it("proposing, picking or binding after an appraiser is bound is refused", async () => {
    const env = await mediating();
    await env.proposeAppraisers(env.landlord, [apprLow]);
    await env.proposeAppraisers(env.tenant, [apprLow]);
    await env.pickAppraiser(env.landlord, apprLow);
    await env.pickAppraiser(env.tenant, apprLow); // binds

    await expectFail(env.proposeAppraisers(env.landlord, [apprHigh]), "AppraiserAlreadyBound");
    await expectFail(env.pickAppraiser(env.landlord, apprHigh), "AppraiserAlreadyBound");
    await expectFail(env.bindDefaultAppraiser(env.tenant), "AppraiserAlreadyBound");
  });

  it("binding re-bases the verdict deadline on the binding, shortening the absolute expiry", async () => {
    const env = await mediating();
    const opened = await program.account.dispute.fetch(env.dispute);
    const provisionalDeadline = opened.verdictDeadline.toNumber();

    await timeTravel(5); // agree well inside the selection window
    await env.proposeAppraisers(env.landlord, [apprLow]);
    await env.proposeAppraisers(env.tenant, [apprLow]);
    await env.pickAppraiser(env.landlord, apprLow);
    await env.pickAppraiser(env.tenant, apprLow);

    const bound = await program.account.dispute.fetch(env.dispute);
    expect(bound.verdictDeadline.toNumber()).to.be.lessThan(provisionalDeadline);
    expect(bound.verdictDeadline.toNumber()).to.be.closeTo((await chainNow()) + VERDICT_WINDOW, 3);
  });

  // ---- the verdict ----

  async function bind(env: Env, appr: Appraiser) {
    await env.proposeAppraisers(env.landlord, [appr]);
    await env.proposeAppraisers(env.tenant, [appr]);
    await env.pickAppraiser(env.landlord, appr);
    await env.pickAppraiser(env.tenant, appr);
  }

  it("only the bound appraiser can submit, even another registered and active one", async () => {
    const env = await mediating();
    await bind(env, apprLow);
    await expectFail(env.submitVerdict(100, apprHigh), "NotBoundAppraiser");
  });

  it("submit_verdict refuses an unbound dispute", async () => {
    const env = await mediating();
    await expectFail(env.submitVerdict(100, apprLow), "AppraiserNotBound");
  });

  it("submit_verdict refuses once the verdict window has closed", async () => {
    const env = await mediating();
    await bind(env, apprLow);
    await timeTravel(VERDICT_WINDOW + 5);
    await expectFail(env.submitVerdict(100, apprLow), "VerdictWindowClosed");
  });

  it("expire_mediation refuses before the verdict window has passed", async () => {
    const env = await mediating();
    await expectFail(env.expireMediation(), "VerdictWindowOpen");
  });

  it("exactly one verdict per dispute: the lease closes and the Dispute account is gone", async () => {
    const env = await mediating();
    await bind(env, apprLow);
    await env.submitVerdict(100, apprLow);
    expect((await program.account.lease.fetch(env.lease)).status).to.have.property("closed");
    expect(await program.account.dispute.fetchNullable(env.dispute)).to.be.null;
    await expectFail(env.submitVerdict(100, apprLow));
  });

  it("a verdict bound on one lease cannot be submitted against another", async () => {
    const envA = await mediating();
    const envB = await mediating();
    await bind(envA, apprLow);

    await expectFail(
      program.methods
        .submitVerdict(new BN(100))
        .accountsPartial({
          appraiser: apprLow.wallet.publicKey, appraiserRecord: apprLow.pda,
          lease: envB.lease, dispute: envA.dispute, mint: envB.mint, vault: envB.vault,
          tenant: envB.tenant.publicKey, tenantAta: envB.tenantAta, landlordAta: envB.landlordAta,
          appraiserAta: apprLow.ata, tenantProfile: envB.tenantProfile, landlordProfile: envB.landlordProfile,
          tokenProgram: envB.tokenProgram,
        })
        .signers([apprLow.wallet])
        .rpc(),
      "ConstraintSeeds"
    );
  });

  // ---- D2 invariant 1 + the fee rule (docs §6) ----

  it("a verdict for the landlord takes the fee from the tenant's refund", async () => {
    const env = await mediating();
    await bind(env, apprLow);
    // 2*1200 > 2000: landlord won; fee 50 (below the 200 cap) comes out of the tenant's 800
    await expectVerdict(env, apprLow, 1200, 750, 1200, 50);
  });

  it("a verdict for the tenant takes the fee from the landlord's share, exercising the cap", async () => {
    const env = await mediating();
    await bind(env, apprHigh);
    // 2*100 <= 2000: tenant won. The registry asks for 500, clamped to the 200 cap; the
    // landlord's 100 covers only half of it, and the rest falls on the tenant's refund last.
    await expectVerdict(env, apprHigh, 100, 1800, 0, 200);
  });

  it("a total win for the tenant (d=0) still costs them the whole fee -- the honest wart", async () => {
    const env = await mediating();
    await bind(env, apprLow);
    await expectVerdict(env, apprLow, 0, 1950, 0, 50);
  });

  // ---- D2 invariant 5: the claim clock ----

  it("each stretch spent unavailable -- Disputed twice, then Mediation -- is paused exactly once", async () => {
    const env = await fullyPaid();
    await timeTravel(CLAIM_WINDOW + 5); // the claim window has already lapsed before any dispute

    await env.release(800); // round 1 proposal: Disputed
    const span1 = Math.max(1, DISPUTE_WINDOW - 3);
    await timeTravel(span1);
    await env.abandon(); // ends the first Disputed stretch

    await env.release(100); // round 2 proposal: Disputed again
    const span2 = Math.max(1, DISPUTE_WINDOW - 3);
    await timeTravel(span2);
    await env.escalate(); // ends the second Disputed stretch, starts the Mediation one

    const mediationSpan = SELECTION_WINDOW + VERDICT_WINDOW + 5;
    await timeTravel(mediationSpan);
    await env.expireMediation(); // ends the Mediation stretch

    const lease = await program.account.lease.fetch(env.lease);
    expect(lease.status).to.have.property("active");
    // every stretch landed in the pause, so the tenant waits at least as long as it was
    // actually unavailable -- never shorter
    const spans = span1 + span2 + mediationSpan;
    expect(lease.claimPauseSecs.toNumber()).to.be.at.least(spans);
    // ...and *exactly* once, which is the half of invariant 5 a lower bound cannot see: a program
    // that counted any stretch twice would still satisfy the line above, and the timeTravel below
    // adapts to whatever pause it finds, so the claim would still succeed. The smallest stretch is
    // span1, so anything at or above `spans + span1` means something was double-counted; the gap
    // below that is the few seconds of real wall-clock the three instructions themselves take.
    expect(lease.claimPauseSecs.toNumber()).to.be.below(spans + span1);

    await timeTravel(lease.claimPauseSecs.toNumber() + CLAIM_WINDOW);
    await env.claim();
    await expectConserved(env, DEPOSIT, 0);
  });

  // ---- D2 invariant 6 (mocha): upgrade compatibility ----
  //
  // Pinned exhaustively in Rust against raw bytes (state.rs,
  // a_lease_written_by_the_deployed_program_upgrades_in_place and its neighbours). This is the
  // same fixture driven through the live program instead of only the client's decoder: Surfpool's
  // surfnet_setAccount cheatcode writes an account's raw bytes directly, so a Lease shaped
  // exactly like the one the deployed (pre-D2) program would have written can be read -- and
  // acted on -- by the upgraded program.

  async function surfnetSetAccount(
    address: anchor.web3.PublicKey, data: Buffer, lamports: number, owner = program.programId,
  ) {
    const res = await (globalThis as any).fetch(connection.rpcEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "surfnet_setAccount",
        params: [address.toBase58(), {
          lamports, data: data.toString("hex"), owner: owner.toBase58(), executable: false, rentEpoch: 0,
        }],
      }),
    });
    const json: any = await res.json();
    if (json.error) throw new Error(JSON.stringify(json.error));
  }

  // Byte-for-byte what the deployed program's Borsh encoder would have written: the same field
  // order as `Lease`, with `status` as its bare enum tag and the last byte -- offset 217 overall,
  // 209 after the 8-byte discriminator -- the old `dispute_rejected: bool`.
  const LEASE_DISCRIMINATOR = Buffer.from("0e67da3df8ea6954", "hex"); // sha256("account:Lease")[..8]
  function encodeLegacyLease(f: {
    landlord: anchor.web3.PublicKey; tenant: anchor.web3.PublicKey; mint: anchor.web3.PublicKey;
    leaseId: number; status: number; bump: number; disputedAt: number; disputeRoundsByte: number;
  }) {
    const b = Buffer.alloc(8 + 210);
    LEASE_DISCRIMINATOR.copy(b, 0);
    let o = 8;
    f.landlord.toBuffer().copy(b, o); o += 32;
    f.tenant.toBuffer().copy(b, o); o += 32;
    f.mint.toBuffer().copy(b, o); o += 32;
    b.writeBigUInt64LE(BigInt(f.leaseId), o); o += 8; // lease_id
    b.writeBigUInt64LE(BigInt(RENT), o); o += 8; // rent_amount
    b.writeBigUInt64LE(BigInt(DEPOSIT), o); o += 8; // deposit_amount
    b.writeBigInt64LE(BigInt(0), o); o += 8; // start_ts
    b.writeUInt16LE(TERM, o); o += 2; // term_periods
    b.writeUInt16LE(TERM, o); o += 2; // paid_count
    Buffer.from(LEASE_HASH).copy(b, o); o += 32; // lease_hash
    b.writeUInt8(f.status, o); o += 1; // status (bare enum tag)
    b.writeUInt8(f.bump, o); o += 1; // bump
    b.writeBigInt64LE(BigInt(PERIOD), o); o += 8; // period_secs
    b.writeBigInt64LE(BigInt(GRACE), o); o += 8; // grace_secs
    Buffer.from(REGION).copy(b, o); o += 2; // region
    b.writeUInt8(0, o); o += 1; // discount_pct
    b.writeBigUInt64LE(BigInt(500), o); o += 8; // proposed_deduction
    b.writeBigInt64LE(BigInt(f.disputedAt), o); o += 8; // disputed_at
    b.writeBigInt64LE(BigInt(0), o); o += 8; // claim_pause_secs
    b.writeUInt8(f.disputeRoundsByte, o); o += 1; // dispute_rounds (was dispute_rejected: bool)
    if (o !== b.length) throw new Error(`legacy Lease layout wrote ${o}, expected ${b.length}`);
    return b;
  }

  it("the live program reads a Lease forged with the deployed program's exact byte layout", async () => {
    const tenant = Keypair.generate();
    await airdrop(tenant);
    const landlord = Keypair.generate().publicKey; // never signs below; no airdrop needed
    const rentLamports = await connection.getMinimumBalanceForRentExemption(218);

    async function forgeDisputedLease(disputeRoundsByte: number) {
      const leaseId = nextLeaseId++;
      const leaseIdBuf = u64(leaseId);
      const [leasePda, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("lease"), landlord.toBuffer(), leaseIdBuf], program.programId
      );
      const bytes = encodeLegacyLease({
        landlord, tenant: tenant.publicKey, mint: USDC, leaseId,
        status: 4 /* Disputed */, bump, disputedAt: await chainNow(), disputeRoundsByte,
      });
      await surfnetSetAccount(leasePda, bytes, rentLamports);
      return leasePda;
    }

    // byte 217 = 0x01, the old `dispute_rejected = true`: reads as dispute_rounds = 1, one round
    // already spent. Under MAX_DISPUTE_ROUNDS = 2 that is the *last* round, not an exhausted one
    // (docs §8): abandon_dispute must refuse it and escalate_to_mediation must accept it -- the
    // new rule applied to an old lease, exercised through the real program and not just decoded.
    const rejectedOnce = await forgeDisputedLease(1);
    await expectFail(
      program.methods.abandonDispute()
        .accountsPartial({ tenant: tenant.publicKey, lease: rejectedOnce })
        .signers([tenant]).rpc(),
      "WrongDisputeRound"
    );
    const dispute1 = pda(Buffer.from("dispute"), rejectedOnce.toBuffer());
    await program.methods.escalateToMediation()
      .accountsPartial({ tenant: tenant.publicKey, lease: rejectedOnce, dispute: dispute1 })
      .signers([tenant]).rpc();
    const afterEscalate = await program.account.lease.fetch(rejectedOnce);
    expect(afterEscalate.status).to.have.property("mediation");
    expect(afterEscalate.disputeRounds).to.equal(2);

    // byte 217 = 0x00, the old `dispute_rejected = false`: reads as dispute_rounds = 0, a round
    // still free, so the round-1 rejection the old program also allowed still works.
    const neverRejected = await forgeDisputedLease(0);
    await program.methods.abandonDispute()
      .accountsPartial({ tenant: tenant.publicKey, lease: neverRejected })
      .signers([tenant]).rpc();
    const afterAbandon = await program.account.lease.fetch(neverRejected);
    expect(afterAbandon.status).to.have.property("active");
    expect(afterAbandon.disputeRounds).to.equal(1);
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
