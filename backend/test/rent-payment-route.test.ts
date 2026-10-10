import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateKeyPairSigner, type Address, type Instruction } from "@solana/kit";
import { associatedTokenAddress } from "../src/confidential.ts";
import { ASSOCIATED_TOKEN_PROGRAM } from "../src/contracts.ts";
import { env } from "../src/env.ts";
import { createRateLimiter, type RateLimiter } from "../src/limits.ts";
import { RejectedTransaction, inspectTransaction } from "../src/txinspect.ts";
import { createTreasury } from "../src/treasury.ts";
import type { TreasuryRpc } from "../src/treasury.ts";
import type { Services } from "../src/services.ts";
import { TOKEN22, WS, acct, build, cast, ix, plan, tx5, type Cast } from "./rentfixtures.ts";
import { corruptSignature, ixSignedBy } from "./txfixtures.ts";

const { createApp } = await import("../src/server.ts");
const { createSessionToken } = await import("../src/auth.ts");

const code = (c: string) => (e: unknown) => e instanceof RejectedTransaction && e.code === c;
const generous = () => createRateLimiter({ maxPerWalletPerHour: 100, maxGlobalPerHour: 100, maxLamportsPerWalletPerDay: 10n ** 12n, maxLamportsGlobalPerDay: 10n ** 12n });

async function fixture(options: { limiter?: RateLimiter; mode?: "mock" | "live" } = {}) {
  const c0 = await cast();
  const mint = c0.mint;
  // The route derives the wallet's token account itself, so the cast has to agree with it.
  const c: Cast = { ...c0, walletToken: await associatedTokenAddress(c0.wallet.address, mint), rules: { ...c0.rules, walletToken: await associatedTokenAddress(c0.wallet.address, mint) } };
  const state = { balance: 10n ** 10n, balanceAfterSim: null as bigint | null, simPre: null as bigint | null, spent: 2_500_000n, simError: null as unknown, failSends: 0, sent: [] as string[] };
  let simulated = false;
  const rpc = {
    getBalance: () => ({
      send: async () => {
        // After the simulation has run, a test can make the next read see a different balance.
        const value = simulated && state.balanceAfterSim !== null ? state.balanceAfterSim : state.balance;
        return { context: { slot: 1n }, value };
      },
    }),
    simulateTransaction: () => ({
      send: async () => {
        simulated = true;
        // `simPre` is the balance the simulation ran against, when it differs from the earlier read.
        const pre = state.simPre ?? state.balance;
        return { context: { slot: 1n }, value: { err: state.simError, accounts: [{ lamports: pre - state.spent }] } };
      },
    }),
    sendTransaction: (wire: string) => ({
      send: async () => {
        if (state.failSends > 0) {
          state.failSends--;
          throw new Error("blockhash not found");
        }
        state.sent.push(wire);
        return "sig";
      },
    }),
  } as unknown as TreasuryRpc;
  const treasury = createTreasury({
    rpc,
    run: (async () => []) as never,
    treasury: c.treasury,
    mint,
    decimals: 6,
    mode: options.mode ?? "live",
    rentPaymentLimiter: options.limiter ?? generous(),
  });
  const services = { treasury: async () => treasury, sponsor: async () => ({ feePayer: "fp" }) } as unknown as Services;
  const app = createApp(services);
  const post = (wallet: string | null, body: unknown, raw = false) =>
    app.request("/api/treasury/rent-payment", {
      method: "POST",
      headers: { "content-type": "application/json", ...(wallet === null ? {} : { authorization: `Bearer ${createSessionToken(wallet).token}` }) },
      body: raw ? (body as string) : JSON.stringify(body),
    });
  const sponsor = (instructions: Instruction[], wallet = c.wallet.address) => build(c, instructions).then((txBase64) => treasury.sponsorRentPayment({ txBase64, wallet }));
  return { c, p: plan(c), state, treasury, post, sponsor };
}
type Fx = Awaited<ReturnType<typeof fixture>>;
const valid = (f: Fx, price = 0n) => [...(price > 0n ? [f.p.computePrice(price)] : []), ...tx5(f.c)];

describe("sponsorRentPayment: the happy path", () => {
  it("co-signs, broadcasts, and adds only the treasury's signature", async () => {
    const f = await fixture();
    const txBase64 = await build(f.c, valid(f));
    const before = inspectTransaction(txBase64);
    const result = await f.treasury.sponsorRentPayment({ txBase64, wallet: f.c.wallet.address });
    assert.equal(result.broadcast, true);
    assert.equal(result.rentLamports, "2500000");
    assert.equal(f.state.sent.length, 1);
    const after = inspectTransaction(f.state.sent[0]!);
    assert.equal(after.numRequiredSignatures, before.numRequiredSignatures);
    assert.deepEqual(after.missingSigners, []);
    for (const [address, signature] of Object.entries(before.transaction.signatures)) {
      if (address === f.c.treasury.address) {
        assert.equal(signature, null);
        continue;
      }
      assert.deepEqual(after.transaction.signatures[address as Address], signature, `${address}'s signature must be untouched`);
    }
    assert.notEqual(after.transaction.signatures[f.c.treasury.address], null);
    assert.deepEqual(after.transaction.messageBytes, before.transaction.messageBytes);
  });

  it("accepts a simulated net credit, because the closing transaction returns the rent", async () => {
    const f = await fixture();
    f.state.spent = -2_000_000n;
    const result = await f.sponsor(valid(f));
    assert.equal(result.broadcast, true);
  });

  // The relaxation is per call, not global: the setup route must still refuse a credit.
  it("does not let the credit relaxation leak into the setup route", async () => {
    const f = await fixture();
    f.state.spent = -2_000_000n;
    const user = await generateKeyPairSigner();
    const setup = await build(f.c, [ixSignedBy(user, undefined, [27, 2])]);
    await assert.rejects(f.treasury.sponsorConfidentialAccountSetup({ txBase64: setup, wallet: user.address }), code("unexpected-credit"));
    assert.equal(f.state.sent.length, 0);
  });
});

describe("sponsorRentPayment: whose transaction it is", () => {
  it("rejects a session wallet that is not a signer", async () => {
    const f = await fixture();
    await assert.rejects(f.sponsor(valid(f), f.c.other.address), code("wallet-mismatch"));
    assert.equal(f.state.sent.length, 0);
  });

  it("rejects the treasury's own address as the session wallet", async () => {
    const f = await fixture();
    await assert.rejects(f.sponsor(valid(f), f.c.treasury.address), code("wallet-mismatch"));
  });

  it("rejects a signer wallet that is not the transfer's authority", async () => {
    const f = await fixture();
    // The wallet signs pay_rent, but someone else authorises the transfer of the wallet's tokens.
    const c = f.c;
    const transfer = f.p.transfer([acct(c.walletToken, 1), acct(c.mint, 0), acct(c.destToken, 1), acct(c.other, 2)]);
    await assert.rejects(f.sponsor([transfer, f.p.payRent()]), code("wrong-authority"));
    assert.equal(f.state.sent.length, 0);
  });

  it("rejects an extra required signer that has not signed", async () => {
    const f = await fixture();
    // An address-only signer role: required by the message, but with nothing to sign it.
    const c = f.c;
    const transfer = f.p.transfer([acct(c.walletToken, 1), acct(c.mint, 0), acct(c.destToken, 1), acct(c.wallet, 2), acct(c.other.address, WS)]);
    await assert.rejects(f.sponsor([transfer, f.p.payRent()]), code("incomplete-signatures"));
    assert.equal(f.state.sent.length, 0);
  });

  it("rejects an extra signer whose signature does not verify", async () => {
    const f = await fixture();
    // Signer order in the message: fee payer, then writable signers (the wallet via pay_rent), ...
    const txBase64 = await build(f.c, valid(f));
    const signers = Object.keys(inspectTransaction(txBase64).transaction.signatures);
    const walletSlot = signers.indexOf(f.c.wallet.address);
    assert.ok(walletSlot > 0);
    await assert.rejects(f.treasury.sponsorRentPayment({ txBase64: corruptSignature(txBase64, walletSlot), wallet: f.c.wallet.address }), code("bad-signature"));
    assert.equal(f.state.sent.length, 0);
  });

  it("rejects a transaction whose treasury slot is already filled", async () => {
    const f = await fixture();
    const txBase64 = await build(f.c, valid(f));
    await f.treasury.sponsorRentPayment({ txBase64, wallet: f.c.wallet.address });
    const signed = f.state.sent[0]!;
    // Replay guard aside, a client handing over an already-signed transaction is refused first.
    await assert.rejects(f.treasury.sponsorRentPayment({ txBase64: signed, wallet: f.c.wallet.address }), code("already-signed"));
  });

  it("rejects a fee payer other than the treasury", async () => {
    const f = await fixture();
    const { buildTx } = await import("./txfixtures.ts");
    const txBase64 = await buildTx({ feePayer: f.c.other.address, instructions: valid(f) });
    await assert.rejects(f.treasury.sponsorRentPayment({ txBase64, wallet: f.c.wallet.address }), code("wrong-fee-payer"));
  });

  it("rejects an instruction on a program outside the allowlist", async () => {
    const f = await fixture();
    const foreign = ix(ASSOCIATED_TOKEN_PROGRAM as Address, [1], [acct(f.c.wallet, 3)]);
    await assert.rejects(f.sponsor([...valid(f), foreign]), code("program-not-allowed"));
  });
});

describe("sponsorRentPayment: bounds", () => {
  it("rejects a transaction over the byte cap", async () => {
    const f = await fixture();
    const fat = ix(plan(f.c).verify().programAddress, new Array(1300).fill(1), [acct(f.c.ctxA.address, 1), acct(f.c.treasury.address, 0)]);
    await assert.rejects(f.sponsor([fat]), code("too-large"));
  });

  it("rejects more instructions than the cap", async () => {
    const f = await fixture();
    const many = Array.from({ length: env.sponsor.maxInstructions + 1 }, () => f.p.computeLimit());
    await assert.rejects(f.sponsor(many), code("too-many-instructions"));
  });

  it("rejects a compute price or limit above the caps", async () => {
    const f = await fixture();
    await assert.rejects(f.sponsor([f.p.computePrice(10_000_001n), ...tx5(f.c)]), code("compute-price"));
    await assert.rejects(f.sponsor([f.p.computeLimit(1_400_000), ...tx5(f.c)]), code("compute-limit"));
    assert.equal(f.state.sent.length, 0);
  });

  it("rejects a simulated spend above the cap", async () => {
    const f = await fixture();
    f.state.spent = env.rentPayment.maxSpendLamports + 1n;
    await assert.rejects(f.sponsor(valid(f)), code("rent-too-high"));
    assert.equal(f.state.sent.length, 0);
  });

  it("accepts a simulated spend exactly at the cap", async () => {
    const f = await fixture();
    f.state.spent = env.rentPayment.maxSpendLamports;
    await f.sponsor(valid(f));
    assert.equal(f.state.sent.length, 1);
  });

  it("rejects when the simulation fails", async () => {
    const f = await fixture();
    f.state.simError = { InstructionError: [0, "Custom"] };
    await assert.rejects(f.sponsor(valid(f)), code("simulation-failed"));
    assert.equal(f.state.sent.length, 0);
  });
});

describe("sponsorRentPayment: replay", () => {
  it("refuses the identical transaction a second time", async () => {
    const f = await fixture();
    const txBase64 = await build(f.c, valid(f));
    await f.treasury.sponsorRentPayment({ txBase64, wallet: f.c.wallet.address });
    await assert.rejects(f.treasury.sponsorRentPayment({ txBase64, wallet: f.c.wallet.address }), code("replay"));
    assert.equal(f.state.sent.length, 1);
  });

  it("lets the same transaction be retried after a send failure", async () => {
    const f = await fixture();
    const txBase64 = await build(f.c, valid(f));
    f.state.failSends = 1;
    await assert.rejects(f.treasury.sponsorRentPayment({ txBase64, wallet: f.c.wallet.address }), /blockhash not found/);
    const retry = await f.treasury.sponsorRentPayment({ txBase64, wallet: f.c.wallet.address });
    assert.equal(retry.broadcast, true);
  });

  it("lets a transaction be retried after it was refused for its simulated spend", async () => {
    const f = await fixture();
    const txBase64 = await build(f.c, valid(f));
    f.state.spent = env.rentPayment.maxSpendLamports + 1n;
    await assert.rejects(f.treasury.sponsorRentPayment({ txBase64, wallet: f.c.wallet.address }), code("rent-too-high"));
    f.state.spent = 1_000_000n;
    await f.treasury.sponsorRentPayment({ txBase64, wallet: f.c.wallet.address });
  });
});

describe("sponsorRentPayment: rate limiting", () => {
  const one = () => createRateLimiter({ maxPerWalletPerHour: 1, maxGlobalPerHour: 10, maxLamportsPerWalletPerDay: 10n ** 12n, maxLamportsGlobalPerDay: 10n ** 12n });

  it("refuses a wallet past its hourly cap with rate-limited", async () => {
    const f = await fixture({ limiter: one() });
    await f.sponsor(valid(f, 1n));
    await assert.rejects(f.sponsor(valid(f, 2n)), code("rate-limited"));
    assert.equal(f.state.sent.length, 1);
  });

  it("does not consume budget for a request that is refused", async () => {
    const f = await fixture({ limiter: one() });
    f.state.spent = env.rentPayment.maxSpendLamports + 1n;
    await assert.rejects(f.sponsor(valid(f, 1n)), code("rent-too-high"));
    await assert.rejects(f.sponsor([ix(ASSOCIATED_TOKEN_PROGRAM as Address, [1], [])]), code("program-not-allowed"));
    f.state.spent = 1_000_000n;
    await f.sponsor(valid(f, 2n));
    assert.equal(f.state.sent.length, 1);
  });
});

describe("POST /api/treasury/rent-payment", () => {
  it("answers 401 without a session", async () => {
    const f = await fixture();
    assert.equal((await f.post(null, { txBase64: await build(f.c, valid(f)) })).status, 401);
  });

  it("answers 400 for a missing, empty or non-string txBase64 and for a body that is not JSON", async () => {
    const f = await fixture();
    for (const body of [{}, { txBase64: "" }, { txBase64: 5 }]) {
      const res = await f.post(f.c.wallet.address, body);
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as { code: string }).code, "malformed-body");
    }
    assert.equal((await f.post(f.c.wallet.address, "not json", true)).status, 400);
  });

  it("co-signs a valid transaction for its own wallet", async () => {
    const f = await fixture();
    const res = await f.post(f.c.wallet.address, { txBase64: await build(f.c, valid(f)) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { signature: string; broadcast: boolean };
    assert.equal(body.broadcast, true);
    assert.ok(body.signature.length > 40);
  });

  it("answers 400 wallet-mismatch for a session that does not own the transaction", async () => {
    const f = await fixture();
    const res = await f.post(f.c.other.address, { txBase64: await build(f.c, valid(f)) });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "wallet-mismatch");
    assert.equal(f.state.sent.length, 0);
  });

  it("answers 400 with the filter's own code for a hostile shape", async () => {
    const f = await fixture();
    const evil = ix(TOKEN22, [27, 7, 1], [acct(f.c.walletToken, 1), acct(f.c.mint, 0), acct(f.c.treasury.address, 2)]);
    const res = await f.post(f.c.wallet.address, { txBase64: await build(f.c, [...valid(f), evil]) });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "treasury-in-token-instruction");
    assert.equal(f.state.sent.length, 0);
  });

  // Review F4. The balance is read in one round trip and the simulation runs in another. This
  // route's own closing transactions CREDIT the treasury, so a credit landing in between made `spent`
  // too small, or negative, and booked almost nothing against the wallet's daily lamport cap.
  describe("spend accounting when the treasury balance moves during the simulation", () => {
    const rentLimiter = () => createRateLimiter({ maxPerWalletPerHour: 100, maxGlobalPerHour: 100, maxLamportsPerWalletPerDay: 10n ** 12n, maxLamportsGlobalPerDay: 10n ** 12n });

    it("books the real debit even though the earlier read was stale (credit in between)", async () => {
      const limiter = rentLimiter();
      const f = await fixture({ limiter });
      // The first read sees 1.0M; by the time the simulation runs the treasury holds 5.0M (a refund
      // landed) and the transaction debits 3.0M from that.
      f.state.balance = 1_000_000n;
      f.state.simPre = 5_000_000n;
      f.state.balanceAfterSim = 5_000_000n;
      f.state.spent = 3_000_000n;
      await f.sponsor(valid(f));
      assert.ok(limiter.snapshot(f.c.wallet.address).walletLamportsLastDay >= 3_000_000n, "a 3M debit was booked as less than 3M");
    });

    it("never books a negative amount for a transaction that only credits the treasury", async () => {
      const limiter = rentLimiter();
      const f = await fixture({ limiter });
      f.state.spent = -4_000_000n; // the closing transaction: the treasury ends up richer
      await f.sponsor(valid(f));
      const booked = limiter.snapshot(f.c.wallet.address).walletLamportsLastDay;
      assert.ok(booked >= 0n, `booked ${booked}`);
      assert.ok(booked < 100_000n, "a pure credit should book only its fee");
    });

    it("refuses on the larger reading: a stale LOW read cannot hide an overspend", async () => {
      const f = await fixture();
      f.state.balance = 1_000_000n;
      f.state.simPre = 50_000_000n;
      f.state.balanceAfterSim = 50_000_000n;
      f.state.spent = 20_000_000n; // above the 12M cap, invisible to the stale read
      await assert.rejects(f.sponsor(valid(f)), code("rent-too-high"));
    });
  });

  // Review F5. "Not broadcast" has to mean "cannot land". A fully signed wire in the response lets
  // any client submit it themselves, so mock mode was not the dry run it reads as.
  describe("mock mode", () => {
    it("co-signs and reports broadcast false, without handing back a landable transaction", async () => {
      const f = await fixture({ mode: "mock" });
      const res = await f.post(f.c.wallet.address, { txBase64: await build(f.c, valid(f)) });
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 200);
      assert.equal(body.broadcast, false);
      assert.equal(body.transactionBase64, undefined, "the signed wire must not be returned");
      assert.ok(!JSON.stringify(body).includes(f.state.sent[0] ?? "\u0000"));
      assert.equal(f.state.sent.length, 0, "nothing is sent to the network either");
    });

    it("live mode still sends, and still does not echo the wire back", async () => {
      const f = await fixture({ mode: "live" });
      const body = (await (await f.post(f.c.wallet.address, { txBase64: await build(f.c, valid(f)) })).json()) as Record<string, unknown>;
      assert.equal(body.broadcast, true);
      assert.equal(body.transactionBase64, undefined);
      assert.equal(f.state.sent.length, 1);
    });
  });

  it("reports a rate limit as a rejected transaction with code rate-limited, like the setup route", async () => {
    const limiter = createRateLimiter({ maxPerWalletPerHour: 1, maxGlobalPerHour: 10, maxLamportsPerWalletPerDay: 10n ** 12n, maxLamportsGlobalPerDay: 10n ** 12n });
    const f = await fixture({ limiter });
    await f.post(f.c.wallet.address, { txBase64: await build(f.c, valid(f, 1n)) });
    const res = await f.post(f.c.wallet.address, { txBase64: await build(f.c, valid(f, 2n)) });
    assert.equal(((await res.json()) as { code: string }).code, "rate-limited");
  });
});
