import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateKeyPairSigner } from "@solana/kit";
import { accountLayout, type Layout } from "../src/layout.ts";
import { createRateLimiter, type RateLimiter } from "../src/limits.ts";
import { createTreasury, type TreasuryRpc } from "../src/treasury.ts";
import { RejectedTransaction } from "../src/txinspect.ts";
import type { Services } from "../src/services.ts";

const { createApp } = await import("../src/server.ts");
const { createSessionToken } = await import("../src/auth.ts");

const APPLICATION = 1_500_000n;
const PROFILE = 1_300_000n;
const AMOUNT = APPLICATION + PROFILE;
const code = (c: string) => (e: unknown) => e instanceof RejectedTransaction && e.code === c;
const limiter = (perWallet = 100, global = 100) =>
  createRateLimiter({ maxPerWalletPerHour: perWallet, maxGlobalPerHour: global, maxLamportsPerWalletPerDay: 10n ** 12n, maxLamportsGlobalPerDay: 10n ** 12n });

type Planned = { kind: string; plans?: Array<{ instruction: { programAddress: string; data: Uint8Array; accounts: Array<{ address: string }> } }> };

async function fixture(options: { limiter?: RateLimiter; balances?: Record<string, bigint>; failRuns?: number; slowBalance?: boolean; layout?: (account: string) => Layout } = {}) {
  const treasurySigner = await generateKeyPairSigner();
  const wallet = (await generateKeyPairSigner()).address;
  const feePayer = (await generateKeyPairSigner()).address;
  const state = { runs: [] as Planned[], failRuns: options.failRuns ?? 0, rentQueries: [] as bigint[] };
  const rpc = {
    getMinimumBalanceForRentExemption: (size: bigint) => ({
      send: async () => {
        state.rentQueries.push(size);
        return size === 104n ? APPLICATION : size === 88n ? PROFILE : size === 120n ? PROFILE + 400_000n : 999n;
      },
    }),
    // A real RPC yields to the event loop here, which is what makes two requests interleave.
    getBalance: (address: string) => ({
      send: async () => {
        if (options.slowBalance) await new Promise((r) => setTimeout(r, 5));
        return { context: { slot: 1n }, value: options.balances?.[address] ?? 0n };
      },
    }),
  } as unknown as TreasuryRpc;
  const treasury = createTreasury({
    rpc,
    run: (async (_payer: unknown, plan: Planned) => {
      if (state.failRuns > 0) {
        state.failRuns--;
        throw new Error("rpc down");
      }
      state.runs.push(plan);
      return ["sig-dust"];
    }) as never,
    treasury: treasurySigner,
    mint: (await generateKeyPairSigner()).address,
    decimals: 6,
    mode: "live",
    rentDustLimiter: options.limiter ?? limiter(),
    ...(options.layout ? { accountLayout: options.layout } : {}),
  });
  const services = { treasury: async () => treasury, sponsor: async () => ({ feePayer }) } as unknown as Services;
  const app = createApp(services);
  const post = (as: string | null, body?: unknown) =>
    app.request("/api/treasury/rent-dust", {
      method: "POST",
      headers: { "content-type": "application/json", ...(as === null ? {} : { authorization: `Bearer ${createSessionToken(as).token}` }) },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  return { treasury, treasurySigner, wallet, feePayer, state, post };
}

describe("rentDustAmount", () => {
  it("is the rent-exempt minimum of an Application (104 bytes) plus a Profile (88 bytes)", async () => {
    const f = await fixture();
    assert.equal(await f.treasury.rentDustAmount(), AMOUNT);
    assert.deepEqual([...f.state.rentQueries].sort((a, b) => (a < b ? -1 : 1)), [88n, 104n]);
  });
});

describe("rentDustAmount follows the program's account layout", () => {
  // The program's Profile is about to change (dispute fields) before the first deploy. The size must
  // come from the layout, so that change reaches the rent amount without anyone editing this module.
  it("asks for the rent of whatever size the layout says, not a constant", async () => {
    const f = await fixture({ layout: (account) => (account === "Profile" ? { ...accountLayout("Profile"), size: 120 } : accountLayout(account)) });
    assert.equal(await f.treasury.rentDustAmount(), APPLICATION + PROFILE + 400_000n);
    assert.deepEqual([...f.state.rentQueries].sort((a, b) => (a < b ? -1 : 1)), [104n, 120n]);
  });
});

describe("grantRentDust", () => {
  it("grants exactly the dust amount as one System transfer from the treasury to the wallet", async () => {
    const f = await fixture();
    const result = await f.treasury.grantRentDust({ wallet: f.wallet });
    assert.deepEqual({ granted: result.granted, lamports: result.lamports, signature: result.signature }, { granted: true, lamports: AMOUNT.toString(), signature: "sig-dust" });
    assert.equal(f.state.runs.length, 1);
    const instructions = f.state.runs[0]!.plans!.map((p) => p.instruction);
    assert.equal(instructions.length, 1);
    const [transfer] = instructions;
    assert.equal(transfer!.programAddress, "11111111111111111111111111111111");
    assert.equal(new DataView(transfer!.data.buffer, transfer!.data.byteOffset).getUint32(0, true), 2, "System Transfer");
    assert.equal(new DataView(transfer!.data.buffer, transfer!.data.byteOffset).getBigUint64(4, true), AMOUNT);
    assert.deepEqual(transfer!.accounts.map((a) => a.address), [f.treasurySigner.address, f.wallet]);
  });

  it("grants once per wallet and runs nothing the second time", async () => {
    const f = await fixture();
    await f.treasury.grantRentDust({ wallet: f.wallet });
    const again = await f.treasury.grantRentDust({ wallet: f.wallet });
    assert.deepEqual(again, { granted: false, lamports: "0", reason: "already-granted" });
    assert.equal(f.state.runs.length, 1);
  });

  it("does not grant to a wallet that already holds enough, and runs nothing", async () => {
    const target = (await generateKeyPairSigner()).address;
    const f = await fixture({ balances: { [target]: AMOUNT } });
    assert.deepEqual(await f.treasury.grantRentDust({ wallet: target }), { granted: false, lamports: "0", reason: "already-funded" });
    assert.equal(f.state.runs.length, 0);
  });

  it("treats a balance one lamport short as not funded", async () => {
    const target = (await generateKeyPairSigner()).address;
    const f = await fixture({ balances: { [target]: AMOUNT - 1n } });
    assert.equal((await f.treasury.grantRentDust({ wallet: target })).granted, true);
  });

  it("refuses the treasury's own address", async () => {
    const f = await fixture();
    await assert.rejects(f.treasury.grantRentDust({ wallet: f.treasurySigner.address }), code("wallet-is-treasury"));
    assert.equal(f.state.runs.length, 0);
  });

  // The once-per-wallet mark is meant to stop two requests that both read "not yet granted" from
  // both paying out. The limiter is made generous so it cannot be what stops the second one.
  // The mark is set synchronously, before the first await, so the second request is turned away
  // without ever reaching the network round trips the first one is waiting on.
  it("grants once when two requests arrive concurrently, with the in-process mark alone", async () => {
    const f = await fixture({ slowBalance: true });
    const results = await Promise.allSettled([f.treasury.grantRentDust({ wallet: f.wallet }), f.treasury.grantRentDust({ wallet: f.wallet })]);
    assert.equal(f.state.runs.length, 1, `the wallet was paid ${f.state.runs.length} times`);
    assert.equal(results.filter((r) => r.status === "fulfilled" && r.value.granted).length, 1);
  });

  it("grants once when two requests arrive concurrently under the default limiter", async () => {
    const f = await fixture({ slowBalance: true, limiter: limiter(1, 100) });
    const results = await Promise.allSettled([f.treasury.grantRentDust({ wallet: f.wallet }), f.treasury.grantRentDust({ wallet: f.wallet })]);
    assert.equal(f.state.runs.length, 1);
    assert.equal(results.filter((r) => r.status === "fulfilled" && r.value.granted).length, 1);
  });

  it("releases the once-per-wallet mark and the limiter budget when the send fails", async () => {
    const f = await fixture({ limiter: limiter(1, 1), failRuns: 1 });
    await assert.rejects(f.treasury.grantRentDust({ wallet: f.wallet }), /rpc down/);
    const retry = await f.treasury.grantRentDust({ wallet: f.wallet });
    assert.equal(retry.granted, true);
    assert.equal(f.state.runs.length, 1);
  });

  it("enforces the limiter's global cap across wallets with rate-limited", async () => {
    const f = await fixture({ limiter: limiter(5, 1) });
    const second = (await generateKeyPairSigner()).address;
    await f.treasury.grantRentDust({ wallet: f.wallet });
    await assert.rejects(f.treasury.grantRentDust({ wallet: second }), code("rate-limited"));
    assert.equal(f.state.runs.length, 1);
  });
});

describe("POST /api/treasury/rent-dust", () => {
  it("answers 401 without a session", async () => {
    const f = await fixture();
    assert.equal((await f.post(null)).status, 401);
    assert.equal(f.state.runs.length, 0);
  });

  it("grants to the session wallet when there is no body at all", async () => {
    const f = await fixture();
    const res = await f.post(f.wallet);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { granted: boolean }).granted, true);
  });

  it("accepts a body that names the session's own wallet", async () => {
    const f = await fixture();
    const res = await f.post(f.wallet, { wallet: f.wallet });
    assert.equal(res.status, 200);
    assert.equal(f.state.runs.length, 1);
  });

  it("refuses a body that names another wallet, and grants nothing", async () => {
    const f = await fixture();
    const victim = (await generateKeyPairSigner()).address;
    const res = await f.post(f.wallet, { wallet: victim });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "wallet-mismatch");
    assert.equal(f.state.runs.length, 0);
  });

  it("refuses the fee payer's wallet", async () => {
    const f = await fixture();
    const res = await f.post(f.feePayer);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "wallet-is-sponsor");
    assert.equal(f.state.runs.length, 0);
  });

  it("refuses the treasury's wallet", async () => {
    const f = await fixture();
    const res = await f.post(f.treasurySigner.address);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "wallet-is-treasury");
  });

  it("does not grant twice through the route", async () => {
    const f = await fixture();
    await f.post(f.wallet);
    const res = await f.post(f.wallet);
    assert.equal(((await res.json()) as { reason: string }).reason, "already-granted");
    assert.equal(f.state.runs.length, 1);
  });

  // `await c.req.json().catch(() => ({}))` only catches a parse failure; a body of literal `null`
  // parses fine and then `.wallet` is read off null.
  it("treats a JSON null body as no body rather than crashing", async () => {
    const f = await fixture();
    const res = await f.post(f.wallet, "null");
    assert.equal(res.status, 200);
  });

  it("treats an unparseable body as no body", async () => {
    const f = await fixture();
    const res = await f.post(f.wallet, "{nope");
    assert.equal(res.status, 200);
  });
});
