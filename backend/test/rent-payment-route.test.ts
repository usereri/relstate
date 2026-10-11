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
import { REAL_CONTEXTS, TOKEN22, WS, acct, build, cast, ix, plan, prepTxs, tx5, type Cast } from "./rentfixtures.ts";
import { corruptSignature, ixSignedBy } from "./txfixtures.ts";

const { createApp } = await import("../src/server.ts");
const { createSessionToken } = await import("../src/auth.ts");

const code = (c: string) => (e: unknown) => e instanceof RejectedTransaction && e.code === c;
const generous = () => createRateLimiter({ maxPerWalletPerHour: 100, maxGlobalPerHour: 100, maxLamportsPerWalletPerDay: 10n ** 12n, maxLamportsGlobalPerDay: 10n ** 12n });

/** `prepare` (default true) runs the four real preparation transactions first, so the wallet's contexts are registered and a tx5 can be admitted; the send log is cleared afterwards. */
async function fixture(options: { limiter?: RateLimiter; mode?: "mock" | "live"; prepare?: boolean } = {}) {
  const c0 = await cast();
  const mint = c0.mint;
  // The route derives the wallet's token account itself, so the cast has to agree with it.
  const c: Cast = { ...c0, walletToken: await associatedTokenAddress(c0.wallet.address, mint), rules: { ...c0.rules, walletToken: await associatedTokenAddress(c0.wallet.address, mint) } };
  const state = { balance: 10n ** 10n, balanceAfterSim: null as bigint | null, simPre: null as bigint | null, spent: 2_500_000n, simError: null as unknown, failSends: 0, walletAccount: true, sent: [] as string[] };
  let simulated = false;
  const rpc = {
    // The range context's rent-exempt minimum, as the cluster reports it.
    getMinimumBalanceForRentExemption: () => ({ send: async () => REAL_CONTEXTS.range.lamports }),
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
    getAccountInfo: () => ({
      send: async () => ({ context: { slot: 1n }, value: state.walletAccount ? { lamports: 1n, data: ["", "base64"], owner: TOKEN22, executable: false, rentEpoch: 0n, space: 0n } : null }),
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
  const prepare = async (wallet = c.wallet.address) => {
    for (const instructions of prepTxs(c)) await sponsor(instructions, wallet);
  };
  if (options.prepare !== false) {
    await prepare();
    state.sent.length = 0;
  }
  return { c, p: plan(c), state, treasury, post, sponsor, prepare };
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
  // The wallet no longer has to sign every transaction. A tx5 built for another wallet is stopped
  // by the shape filter first (its transfer is not from `other`'s own account); the registry case
  // (right shape, foreign contexts) is in rentplan-route.test.ts.
  it("rejects a session wallet that is not the transaction's wallet", async () => {
    const f = await fixture();
    await assert.rejects(f.sponsor(valid(f), f.c.other.address), code("wrong-source"));
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
    // Preparation transactions count against the same limiter as the final one.
    const f = await fixture({ limiter: one(), prepare: false });
    await f.sponsor(prepTxs(f.c, 1)[0]!);
    await assert.rejects(f.sponsor(prepTxs(f.c, 2)[1]!), code("rate-limited"));
    assert.equal(f.state.sent.length, 1);
  });

  it("does not consume budget for a request that is refused", async () => {
    const f = await fixture({ limiter: one(), prepare: false });
    f.state.spent = env.rentPayment.maxSpendLamports + 1n;
    await assert.rejects(f.sponsor(prepTxs(f.c, 1)[0]!), code("rent-too-high"));
    await assert.rejects(f.sponsor([ix(ASSOCIATED_TOKEN_PROGRAM as Address, [1], [])]), code("program-not-allowed"));
    f.state.spent = 1_000_000n;
    await f.sponsor(prepTxs(f.c, 2)[0]!);
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

  it("answers 400 for a session that does not own the transaction", async () => {
    const f = await fixture();
    const res = await f.post(f.c.other.address, { txBase64: await build(f.c, valid(f)) });
    assert.equal(res.status, 400);
    assert.notEqual(((await res.json()) as { code: string }).code, undefined);
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
      const bookedBefore = limiter.snapshot(f.c.wallet.address).walletLamportsLastDay;
      f.state.spent = -4_000_000n; // the closing transaction: the treasury ends up richer
      await f.sponsor(valid(f));
      const booked = limiter.snapshot(f.c.wallet.address).walletLamportsLastDay - bookedBefore;
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
    const f = await fixture({ limiter, prepare: false });
    await f.post(f.c.wallet.address, { txBase64: await build(f.c, prepTxs(f.c, 1)[0]!) });
    const res = await f.post(f.c.wallet.address, { txBase64: await build(f.c, prepTxs(f.c, 2)[1]!) });
    assert.equal(((await res.json()) as { code: string }).code, "rate-limited");
  });
});

// The wallet signs only tx5; the four transactions before it are bound to the wallet by the plan
// registry (src/rentplan.ts). `prepare: false` so each test drives the sequence itself.
describe("sponsorRentPayment: the preparation transactions and the plan registry", () => {
  const prep = (f: Fx, salt = 0) => prepTxs(f.c, salt);
  /** The cast re-pointed at another wallet, so its tx5 passes the shape filter for that wallet. */
  const castFor = async (f: Fx, who: { address: Address }) => {
    const walletToken = await associatedTokenAddress(who.address, f.c.mint);
    return { ...f.c, wallet: who as Cast["wallet"], walletToken, rules: { ...f.c.rules, wallet: who.address, walletToken } } as Cast;
  };
  const rejectedCode = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      if (e instanceof RejectedTransaction) return e.code;
      throw e;
    }
    return "accepted";
  };

  it("accepts the real five-transaction sequence in order, and spends the contexts", async () => {
    const f = await fixture({ prepare: false });
    const txs = prep(f);
    for (const t of txs) assert.equal((await f.sponsor(t)).broadcast, true);
    assert.equal((await f.sponsor(tx5(f.c))).broadcast, true);
    assert.equal(f.state.sent.length, 5);
    // Registry empty afterwards: a verify of the (closed) context C no longer names a registered one,
    // and a fresh create of the same account is allowed again.
    assert.equal(await rejectedCode(f.sponsor(prep(f, 9)[3]!)), "foreign-context");
    assert.equal(await rejectedCode(f.sponsor(prep(f, 10)[0]!)), "accepted");
  });

  it("refuses the final transaction before its contexts exist", async () => {
    const f = await fixture({ prepare: false });
    await assert.rejects(f.sponsor(tx5(f.c)), code("foreign-context"));
    // ...and one with only part of the plan done.
    await f.sponsor(prep(f)[0]!);
    await assert.rejects(f.sponsor(tx5(f.c)), code("foreign-context"));
    assert.equal(f.state.sent.length, 1);
  });

  it("refuses another wallet borrowing wallet 1's verify of C", async () => {
    const f = await fixture({ prepare: false });
    for (const t of prep(f).slice(0, 3)) await f.sponsor(t);
    await assert.rejects(f.sponsor(prep(f, 5)[3]!, f.c.other.address), code("foreign-context"));
    // The owner is unaffected.
    await f.sponsor(prep(f)[3]!);
  });

  it("refuses another wallet's final transaction closing wallet 1's contexts", async () => {
    const f = await fixture({ prepare: false });
    await f.prepare();
    const other = await castFor(f, f.c.other);
    await assert.rejects(build(other, tx5(other)).then((txBase64) => f.treasury.sponsorRentPayment({ txBase64, wallet: other.wallet.address })), code("foreign-context"));
    // Nothing of wallet 1's was consumed by the failed attempt.
    assert.equal((await f.sponsor(tx5(f.c))).broadcast, true);
  });

  it("refuses a preparation transaction with no relation to a wallet", async () => {
    const f = await fixture({ prepare: false });
    await assert.rejects(f.sponsor([f.p.computeLimit(123_456)]), code("no-wallet-relation"));
    assert.equal(f.state.sent.length, 0);
  });

  it("still applies the shape filter to unsigned preparation transactions", async () => {
    const f = await fixture({ prepare: false });
    const p = f.p;
    const small = REAL_CONTEXTS.equality;
    await assert.rejects(f.sponsor([p.createContext(f.c.ctxA, { space: env.rentPayment.maxContextSpace + 1n }), p.verify(f.c.ctxA)]), code("context-too-large"));
    await assert.rejects(f.sponsor([p.createContext(f.c.ctxA, { lamports: env.rentPayment.maxContextLamports + 1n, space: small.space }), p.verify(f.c.ctxA)]), code("context-too-expensive"));
    await assert.rejects(f.sponsor([p.createContext(f.c.ctxA, { space: 0n }), p.verify(f.c.ctxA)]), code("context-too-large"));
    assert.equal(f.state.sent.length, 0);
  });

  it("refuses to replay a preparation transaction after the plan was completed", async () => {
    const f = await fixture({ prepare: false });
    await f.prepare();
    await f.sponsor(tx5(f.c));
    // A fresh message of the same shape (the identical one would hit the replay guard first).
    await assert.rejects(f.sponsor(prep(f, 7)[3]!), code("foreign-context"));
  });

  it("refuses to re-create a context that is still registered to another wallet", async () => {
    const f = await fixture({ prepare: false });
    await f.sponsor(prep(f)[0]!);
    await assert.rejects(f.sponsor(prep(f, 3)[0]!, f.c.other.address), code("context-reused"));
    // Nor can the same wallet create it twice.
    await assert.rejects(f.sponsor(prep(f, 4)[0]!), code("context-reused"));
  });

  it("refuses a preparation transaction for a wallet without an rUSDC account", async () => {
    const f = await fixture({ prepare: false });
    f.state.walletAccount = false;
    await assert.rejects(f.sponsor(prep(f)[0]!), code("wallet-mismatch"));
    assert.equal(f.state.sent.length, 0);
    // Nothing was registered by the refusal.
    f.state.walletAccount = true;
    await f.sponsor(prep(f)[0]!);
  });

  it("rolls the registry back when the send fails, so the same transaction can be retried", async () => {
    const f = await fixture({ prepare: false });
    const txs = prep(f);
    const first = await build(f.c, txs[0]!);
    f.state.failSends = 1;
    await assert.rejects(f.treasury.sponsorRentPayment({ txBase64: first, wallet: f.c.wallet.address }), /blockhash not found/);
    // A failed create must not leave A registered: the identical transaction is accepted, not context-reused.
    await f.treasury.sponsorRentPayment({ txBase64: first, wallet: f.c.wallet.address });
    await f.sponsor(txs[1]!);
    await f.sponsor(txs[2]!);
    // A failed verify of C does not strand the plan either.
    const verifyC = await build(f.c, txs[3]!);
    f.state.failSends = 1;
    await assert.rejects(f.treasury.sponsorRentPayment({ txBase64: verifyC, wallet: f.c.wallet.address }), /blockhash not found/);
    await f.treasury.sponsorRentPayment({ txBase64: verifyC, wallet: f.c.wallet.address });
    assert.equal((await f.sponsor(tx5(f.c))).broadcast, true);
  });

  it("restores consumed contexts when the final transaction fails to send", async () => {
    const f = await fixture({ prepare: false });
    await f.prepare();
    const last = await build(f.c, tx5(f.c));
    f.state.failSends = 1;
    await assert.rejects(f.treasury.sponsorRentPayment({ txBase64: last, wallet: f.c.wallet.address }), /blockhash not found/);
    assert.equal((await f.treasury.sponsorRentPayment({ txBase64: last, wallet: f.c.wallet.address })).broadcast, true);
  });

  it("caps a plan at six preparation transactions", async () => {
    const f = await fixture({ prepare: false });
    await f.prepare();
    // Two spares (verifying a registered context again), then the seventh is refused.
    await f.sponsor([f.p.computeLimit(210_001), f.p.verify(f.c.ctxA, REAL_CONTEXTS.equality.verifyTag)]);
    await f.sponsor([f.p.computeLimit(210_002), f.p.verify(f.c.ctxA, REAL_CONTEXTS.equality.verifyTag)]);
    await assert.rejects(f.sponsor([f.p.computeLimit(210_003), f.p.verify(f.c.ctxA, REAL_CONTEXTS.equality.verifyTag)]), code("plan-full"));
    // The final transaction is not a preparation and is still allowed.
    assert.equal((await f.sponsor(tx5(f.c))).broadcast, true);
  });

  it("rate-limits preparation transactions globally and per wallet", async () => {
    const global = createRateLimiter({ maxPerWalletPerHour: 100, maxGlobalPerHour: 1, maxLamportsPerWalletPerDay: 10n ** 12n, maxLamportsGlobalPerDay: 10n ** 12n });
    const g = await fixture({ limiter: global, prepare: false });
    await g.sponsor(prep(g)[0]!);
    await assert.rejects(g.sponsor(prep(g)[1]!), code("rate-limited"));
    await assert.rejects(g.sponsor(prep(g, 1)[0]!, g.c.other.address), code("rate-limited"));

    const lamports = createRateLimiter({ maxPerWalletPerHour: 100, maxGlobalPerHour: 100, maxLamportsPerWalletPerDay: 1n, maxLamportsGlobalPerDay: 10n ** 12n });
    const w = await fixture({ limiter: lamports, prepare: false });
    await assert.rejects(w.sponsor(prep(w)[0]!), code("rate-limited"));
  });
});
