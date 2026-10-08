import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBase64Encoder, getTransactionDecoder, type Address } from "@solana/kit";
import { createRateLimiter, LimitError, type LimitConfig } from "../src/limits.ts";
import { createSponsorService, type SponsorPolicyFull, type SponsorRpc } from "../src/sponsor.ts";
import { RejectedTransaction } from "../src/txinspect.ts";
import { TOKEN_PROGRAM, buildTx, ixSignedBy, ixTouching, twoKeys } from "./txfixtures.ts";

const policy: SponsorPolicyFull = {
  allowlist: [TOKEN_PROGRAM],
  maxTxBytes: 1232,
  maxInstructions: 16,
  maxComputeUnits: 400_000,
  maxCuPriceMicroLamports: 10_000n,
  maxFeeLamports: 200_000n,
};

const limits: LimitConfig = {
  maxPerWalletPerHour: 2,
  maxGlobalPerHour: 100,
  maxLamportsPerWalletPerDay: 1_000_000n,
  maxLamportsGlobalPerDay: 1_000_000n,
};

type Sim = { err: unknown; logs?: string[]; unitsConsumed?: bigint };

function fakeRpc(sim: Sim = { err: null, unitsConsumed: 1000n }) {
  const calls = { simulate: 0, send: 0, sent: [] as string[] };
  const rpc = {
    simulateTransaction: () => {
      calls.simulate++;
      return { send: async () => ({ value: sim }) };
    },
    sendTransaction: (wire: string) => {
      calls.send++;
      calls.sent.push(wire);
      return { send: async () => "sig" };
    },
  } as unknown as SponsorRpc;
  return { rpc, calls };
}

async function setup(options: { sim?: Sim; simulate?: boolean; broadcast?: boolean } = {}) {
  const { sponsor: feePayer, user } = await twoKeys();
  const { rpc, calls } = fakeRpc(options.sim);
  const limiter = createRateLimiter(limits);
  const service = createSponsorService({
    rpc,
    feePayer,
    limiter,
    policy,
    broadcast: options.broadcast ?? true,
    simulate: options.simulate ?? true,
    now: () => 1_000_000,
  });
  const txBase64 = await buildTx({ feePayer: feePayer.address, instructions: [ixSignedBy(user)] });
  return { service, limiter, calls, feePayer, user, txBase64, wallet: user.address as string };
}

const usage = (s: Awaited<ReturnType<typeof setup>>) => s.limiter.snapshot(s.wallet, 1_000_000);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof RejectedTransaction, `expected RejectedTransaction, got ${String(e)}`);
    return e.code;
  }
  assert.fail("expected a rejection");
}

describe("sponsor service", () => {
  it("co-signs, simulates, broadcasts and commits the reservation", async () => {
    const s = await setup();
    const result = await s.service.sponsor({ txBase64: s.txBase64, wallet: s.wallet });
    assert.equal(result.broadcast, true);
    assert.equal(result.feeLamports, "10000");
    assert.equal(result.unitsConsumed, "1000");
    assert.equal(s.calls.simulate, 1);
    assert.equal(s.calls.send, 1);
    assert.equal(usage(s).walletLastHour, 1);
    assert.equal(usage(s).walletLamportsLastDay, 10_000n);

    // The broadcast transaction carries every signature, including the sponsor's.
    const sent = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(s.calls.sent[0] as string)));
    assert.ok(Object.values(sent.signatures).every((sig) => sig !== null));
    assert.ok(s.feePayer.address in sent.signatures);
  });

  it("signs nothing and sends nothing when simulation returns an error", async () => {
    const s = await setup({ sim: { err: { InstructionError: [0, "Custom"] }, logs: ["boom"] } });
    assert.equal(await codeOf(s.service.sponsor({ txBase64: s.txBase64, wallet: s.wallet })), "simulation-failed");
    assert.equal(s.calls.send, 0);
  });

  it("cancels the reservation when simulation fails, so a later call is not penalised", async () => {
    const s = await setup({ sim: { err: "AccountNotFound" } });
    for (let i = 0; i < 5; i++) {
      // More failures than the per-wallet hourly cap of 2: none may become a LimitError.
      assert.equal(await codeOf(s.service.sponsor({ txBase64: s.txBase64, wallet: s.wallet })), "simulation-failed");
    }
    assert.equal(usage(s).walletLastHour, 0);
    assert.equal(usage(s).walletLamportsLastDay, 0n);
  });

  it("cancels the reservation when simulated compute exceeds the cap", async () => {
    const s = await setup({ sim: { err: null, unitsConsumed: 400_001n } });
    assert.equal(await codeOf(s.service.sponsor({ txBase64: s.txBase64, wallet: s.wallet })), "compute-limit");
    assert.equal(s.calls.send, 0);
    assert.equal(usage(s).walletLastHour, 0);
  });

  it("cancels the reservation when broadcasting throws", async () => {
    const s = await setup();
    const failing = {
      simulateTransaction: () => ({ send: async () => ({ value: { err: null, unitsConsumed: 1n } }) }),
      sendTransaction: () => ({ send: async () => { throw new Error("rpc down"); } }),
    } as unknown as SponsorRpc;
    const service = createSponsorService({ rpc: failing, feePayer: s.feePayer, limiter: s.limiter, policy, broadcast: true, simulate: true, now: () => 1_000_000 });
    await assert.rejects(service.sponsor({ txBase64: s.txBase64, wallet: s.wallet }), /rpc down/);
    assert.equal(usage(s).walletLastHour, 0);
  });

  it("enforces the per-wallet hourly cap once committed calls fill it", async () => {
    const s = await setup();
    await s.service.sponsor({ txBase64: s.txBase64, wallet: s.wallet });
    await s.service.sponsor({ txBase64: s.txBase64, wallet: s.wallet });
    await assert.rejects(s.service.sponsor({ txBase64: s.txBase64, wallet: s.wallet }), LimitError);
    assert.equal(s.calls.send, 2);
  });

  it("simulate: false skips simulation", async () => {
    const s = await setup({ simulate: false, sim: { err: "would fail if simulated" } });
    const result = await s.service.sponsor({ txBase64: s.txBase64, wallet: s.wallet });
    assert.equal(s.calls.simulate, 0);
    assert.equal(result.unitsConsumed, undefined);
    assert.equal(result.broadcast, true);
  });

  it("broadcast: false returns the co-signed transaction and never calls sendTransaction", async () => {
    const s = await setup({ broadcast: false });
    const result = await s.service.sponsor({ txBase64: s.txBase64, wallet: s.wallet });
    assert.equal(result.broadcast, false);
    assert.equal(s.calls.send, 0);
    assert.ok(result.transactionBase64);
    const wire = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(result.transactionBase64 as string)));
    assert.ok(Object.values(wire.signatures).every((sig) => sig !== null), "fully signed");
    assert.equal(usage(s).walletLastHour, 1, "a co-signed transaction still counts against the caps");
  });

  it("rejects a session wallet that is not a signer (wallet-mismatch) before reserving anything", async () => {
    const s = await setup();
    const other = (await twoKeys()).user.address;
    assert.equal(await codeOf(s.service.sponsor({ txBase64: s.txBase64, wallet: other })), "wallet-mismatch");
    assert.equal(s.calls.simulate, 0);
    assert.equal(s.limiter.snapshot(other, 1_000_000).walletLastHour, 0);
  });

  it("does not accept the fee payer as the session wallet", { todo: "BUG: sponsor.ts only checks that the wallet is *a* signer, and the fee payer always is; reported to the implementer" }, async () => {
    const s = await setup();
    // The fee payer is a required signer of the message, so naming it as the wallet
    // would let a session spend its own budget on someone else's transaction.
    const code = await codeOf(s.service.sponsor({ txBase64: s.txBase64, wallet: s.feePayer.address }));
    assert.equal(code, "wallet-mismatch");
  });

  it("runs the static checks before anything touches the network", async () => {
    const s = await setup();
    const bad = await buildTx({ feePayer: s.feePayer.address, instructions: [ixSignedBy(s.user), ixTouching(s.feePayer.address as Address)] });
    assert.equal(await codeOf(s.service.sponsor({ txBase64: bad, wallet: s.wallet })), "sponsor-in-instruction");
    assert.equal(s.calls.simulate, 0);
    assert.equal(s.calls.send, 0);
  });
});
