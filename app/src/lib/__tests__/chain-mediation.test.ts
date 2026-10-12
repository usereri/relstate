import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as anchor from "@anchor-lang/core";
import idl from "@target/idl/relstate.json";
import { localKeypair, localWallet } from "../wallet";
import { MAX_CANDIDATES } from "../mediation";
import type { LeaseView } from "../chain";

const { PublicKey } = anchor.web3;
const PROGRAM_ID = new PublicKey(idl.address);

// Account metas the client actually produces for the mediation instructions
// (docs/contracts/dispute-mediation.md §3-4): an OMITTED optional account is not the same as an
// explicit `null` to Anchor's resolver -- omitted gets the PDA derived from the IDL seeds and sent,
// null sends the program id. Every wrapper below must send an explicit value for every optional
// slot it does not use, or a stale build would silently send the wrong account.
const disputePda = (lease: anchor.web3.PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("dispute"), lease.toBuffer()], PROGRAM_ID)[0];
const appraiserPda = (wallet: anchor.web3.PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("appraiser"), wallet.toBuffer()], PROGRAM_ID)[0];

// Reads the account ORDER straight off the IDL rather than hard-coding positions, so a reordering
// of the program's own account list would fail this test instead of passing it silently.
type IdlInstruction = { name: string; accounts: { name: string }[] };
const accountOrder = (name: string) => {
  const ix = (idl as { instructions: IdlInstruction[] }).instructions.find((i) => i.name === name);
  if (!ix) throw new Error(`instruction ${name} not found in IDL`);
  return ix.accounts.map((a) => a.name);
};

// camelCase <-> snake_case: the IDL names accounts snake_case, the generated client camelCase.
const camel = (snake: string) => snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function metas(tx: anchor.web3.Transaction, idlName: string) {
  const ix = tx.instructions[0];
  const order = accountOrder(idlName);
  const byName: Record<string, string> = {};
  order.forEach((snakeName, i) => (byName[camel(snakeName)] = ix.keys[i].pubkey.toBase58()));
  return byName;
}

// chain.ts builds a Connection at module load and config.ts needs an RPC; neither touches the
// network for anything stubbed below (see app/src/lib/__tests__/chain.test.ts for the same pattern).
beforeEach(() => {
  vi.stubEnv("VITE_RPC", "http://127.0.0.1:8899");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function load(owner: anchor.web3.PublicKey | null = anchor.web3.SystemProgram.programId) {
  vi.resetModules();
  const chain = await import("../chain");
  vi.spyOn(chain.connection, "getAccountInfo").mockImplementation((async () => (owner ? { owner } : null)) as never);
  return chain;
}

const lease = (overrides: Partial<LeaseView> = {}): LeaseView => ({
  address: new PublicKey(PublicKey.unique()).toBase58(),
  id: "1",
  landlord: localKeypair("landlord").publicKey.toBase58(),
  tenant: localKeypair("tenant").publicKey.toBase58(),
  mint: PublicKey.default.toBase58(),
  rent: 1_000_000,
  deposit: 10_000_000,
  startTs: 0,
  termPeriods: 3,
  paidCount: 0,
  periodSecs: 30 * 86_400,
  graceSecs: 3 * 86_400,
  hashHex: "00",
  region: "PL",
  discountPct: 0,
  status: "disputed",
  proposedDeduction: 0,
  disputedAt: 0,
  claimPauseSecs: 0,
  disputeRounds: 1,
  ...overrides,
});

describe("settleDisputeTx: the dispute account slot", () => {
  it("in Disputed, puts the PROGRAM ID in the dispute slot (Anchor's encoding of None)", async () => {
    const chain = await load();
    const me = chain.makeMe(localWallet("tenant"));
    const tx = await chain.settleDisputeTx(me, lease({ status: "disputed" }), 0);
    const ix = tx.instructions[0];
    const order = accountOrder("settle_dispute");
    const disputeSlot = ix.keys[order.indexOf("dispute")].pubkey;
    expect(disputeSlot.toBase58()).toBe(PROGRAM_ID.toBase58());
  });

  it("in Mediation, puts the real [b\"dispute\", lease] PDA in the dispute slot", async () => {
    const chain = await load();
    const me = chain.makeMe(localWallet("tenant"));
    const l = lease({ status: "mediation" });
    const tx = await chain.settleDisputeTx(me, l, 0);
    const ix = tx.instructions[0];
    const order = accountOrder("settle_dispute");
    const disputeSlot = ix.keys[order.indexOf("dispute")].pubkey;
    expect(disputeSlot.toBase58()).toBe(disputePda(new PublicKey(l.address)).toBase58());
    expect(disputeSlot.toBase58()).not.toBe(PROGRAM_ID.toBase58());
  });
});

/**
 * The five remaining mediation wrappers all go through `send()`, which calls `simulate()` then
 * `rpc()` (no VITE_API, so SPONSORED is false) -- both touch the network through
 * `AnchorProvider.sendAndConfirm` / `.simulate`. Overriding those two prototype methods captures the
 * built `Transaction` (already resolved, no PDA derivation left to do) before anything is sent, the
 * same way chain.test.ts stubs `getAccountInfo` to keep `tokenProgram()` off the network.
 */
type Chain = Awaited<ReturnType<typeof load>>;
async function capture(run: (chain: Chain, me: ReturnType<Chain["makeMe"]>) => Promise<unknown>) {
  const chain = await load();
  const me = chain.makeMe(localWallet("tenant"));
  let captured: anchor.web3.Transaction | undefined;
  vi.spyOn(anchor.AnchorProvider.prototype, "simulate").mockImplementation((async (tx: unknown) => {
    captured ??= tx as anchor.web3.Transaction;
    return { logs: [] } as never;
  }) as never);
  vi.spyOn(anchor.AnchorProvider.prototype, "sendAndConfirm").mockResolvedValue("SIGNATURE" as never);
  await run(chain, me);
  if (!captured) throw new Error("the instruction never reached AnchorProvider.simulate");
  return captured;
}

describe("proposeAppraisers: the three candidate slots", () => {
  const w1 = localKeypair("landlord").publicKey;
  const w2 = localKeypair("tenant").publicKey;
  const w3 = PublicKey.unique();

  it("with one wallet: the first slot holds its PDA, the other two hold the program id", async () => {
    const tx = await capture((chain, me) => chain.proposeAppraisers(me, lease({ status: "mediation" }), [w1.toBase58()]));
    const m = metas(tx, "propose_appraisers");
    expect(m.appraiserOne).toBe(appraiserPda(w1).toBase58());
    expect(m.appraiserTwo).toBe(PROGRAM_ID.toBase58());
    expect(m.appraiserThree).toBe(PROGRAM_ID.toBase58());
  });

  it("with two wallets: the named slots hold PDAs in order, the unused slot holds the program id", async () => {
    const tx = await capture((chain, me) => chain.proposeAppraisers(me, lease({ status: "mediation" }), [w1.toBase58(), w2.toBase58()]));
    const m = metas(tx, "propose_appraisers");
    expect(m.appraiserOne).toBe(appraiserPda(w1).toBase58());
    expect(m.appraiserTwo).toBe(appraiserPda(w2).toBase58());
    expect(m.appraiserThree).toBe(PROGRAM_ID.toBase58());
  });

  it("with three wallets: every slot holds a PDA, in the order given", async () => {
    const tx = await capture((chain, me) =>
      chain.proposeAppraisers(me, lease({ status: "mediation" }), [w1.toBase58(), w2.toBase58(), w3.toBase58()]),
    );
    const m = metas(tx, "propose_appraisers");
    expect(m.appraiserOne).toBe(appraiserPda(w1).toBase58());
    expect(m.appraiserTwo).toBe(appraiserPda(w2).toBase58());
    expect(m.appraiserThree).toBe(appraiserPda(w3).toBase58());
  });
});

describe("proposeAppraisers: invalid candidate lists", () => {
  it("gives each invalid list a distinct error before building or sending a transaction", async () => {
    vi.stubEnv("VITE_API", "");
    const chain = await load();
    const me = chain.makeMe(localWallet("tenant"));
    const buildInstruction = vi.spyOn(me.program.methods, "proposeAppraisers");
    // If a regression reaches the send path, keep the test isolated from any network call and
    // assert that neither simulation nor submission was attempted.
    const simulate = vi.spyOn(anchor.AnchorProvider.prototype, "simulate").mockResolvedValue({ logs: [] } as never);
    const send = vi.spyOn(anchor.AnchorProvider.prototype, "sendAndConfirm").mockResolvedValue("SIGNATURE" as never);
    const duplicate = localKeypair("landlord").publicKey.toBase58();
    const tooMany = Array.from({ length: MAX_CANDIDATES + 1 }, () => PublicKey.unique().toBase58());
    const invalidLists = [[], tooMany, [duplicate, duplicate]];

    const errors: unknown[] = [];
    for (const wallets of invalidLists) {
      try {
        await chain.proposeAppraisers(me, lease({ status: "mediation" }), wallets);
        errors.push(null);
      } catch (error) {
        errors.push(error);
      }
    }

    expect(errors.every((error) => error instanceof Error)).toBe(true);
    const messages = errors.map((error) => (error as Error).message);
    expect(messages[0]).toMatch(/at least one appraiser/);
    expect(messages[1]).toContain(`at most ${MAX_CANDIDATES} appraisers`);
    expect(messages[2]).toMatch(/only be put forward once/);
    expect(new Set(messages).size).toBe(3);
    expect(buildInstruction).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("pickAppraiser / bindDefaultAppraiser: the appraiser slot", () => {
  const wallet = PublicKey.unique();

  it("pickAppraiser puts the [b\"appraiser\", wallet] PDA in the appraiser slot", async () => {
    const tx = await capture((chain, me) => chain.pickAppraiser(me, lease({ status: "mediation" }), wallet.toBase58()));
    const m = metas(tx, "pick_appraiser");
    expect(m.appraiser).toBe(appraiserPda(wallet).toBase58());
  });

  it("bindDefaultAppraiser puts the [b\"appraiser\", wallet] PDA in the appraiser slot", async () => {
    const tx = await capture((chain, me) => chain.bindDefaultAppraiser(me, lease({ status: "mediation" }), wallet.toBase58()));
    const m = metas(tx, "bind_default_appraiser");
    expect(m.appraiser).toBe(appraiserPda(wallet).toBase58());
  });
});

describe("escalateToMediation / expireMediation: the dispute slot", () => {
  it("escalateToMediation puts the [b\"dispute\", lease] PDA in the dispute slot", async () => {
    const l = lease({ status: "disputed" });
    const tx = await capture((chain, me) => chain.escalateToMediation(me, l));
    const m = metas(tx, "escalate_to_mediation");
    expect(m.dispute).toBe(disputePda(new PublicKey(l.address)).toBase58());
  });

  it("expireMediation puts the [b\"dispute\", lease] PDA in the dispute slot, and names lease.tenant in the tenant slot", async () => {
    const l = lease({ status: "mediation" });
    const tx = await capture((chain, me) => chain.expireMediation(me, l));
    const m = metas(tx, "expire_mediation");
    expect(m.dispute).toBe(disputePda(new PublicKey(l.address)).toBase58());
    // No `relations` on this account in the IDL, so Anchor cannot resolve it itself -- the client
    // must name it, because the dispute's rent goes back to this exact key on close.
    expect(m.tenant).toBe(l.tenant);
  });
});
