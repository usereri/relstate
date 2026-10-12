import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as anchor from "@anchor-lang/core";
import idl from "@target/idl/relstate.json";
import { localKeypair, localWallet } from "../wallet";
import { MAX_CANDIDATES } from "../appraisers";
import type { LeaseView } from "../chain";

const { PublicKey } = anchor.web3;
const PROGRAM_ID = new PublicKey(idl.address);

// Account metas the client actually produces for the mediation instructions
// (docs/contracts/dispute-mediation.md §3-4): an OMITTED optional account is not the same as an
// explicit `null` to Anchor's resolver -- omitted gets the PDA derived from the IDL seeds and sent,
// null sends the program id. Every wrapper below must send an explicit value for every optional
// slot it does not use, or a stale build would silently send the wrong account.
const disputePda = (lease: anchor.web3.PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("dispute"), lease.toBuffer()], PROGRAM_ID)[0];

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

const LEASE = () => lease({ status: "mediation", deposit: 10_000_000 });
const stranger = PublicKey.unique().toBase58();

describe("proposeAppraisers", () => {
  it("sends the candidates vec (normalised name, fee) and only party/lease/dispute accounts", async () => {
    const l = LEASE();
    const tx = await capture((chain, me) =>
      chain.proposeAppraisers(me, l, [{ name: "  Acme   Wycena ", fee: 500_000 }, { name: "Beta", fee: 0 }]),
    );
    const m = metas(tx, "propose_appraisers");
    expect(Object.keys(m)).toEqual(["party", "lease", "dispute"]);
    expect(m.dispute).toBe(disputePda(new PublicKey(l.address)).toBase58());
    expect(tx.instructions[0].data.length).toBeGreaterThan(8 + 4);
    // the display form is what is sent, so what the screen showed is what gets hashed
    expect(tx.instructions[0].data.includes(Buffer.from("Acme Wycena"))).toBe(true);
  });

  it("rejects each invalid list distinctly, before building or sending anything", async () => {
    vi.stubEnv("VITE_API", "");
    const chain = await load();
    const me = chain.makeMe(localWallet("tenant"));
    const build = vi.spyOn(me.program.methods, "proposeAppraisers");
    const simulate = vi.spyOn(anchor.AnchorProvider.prototype, "simulate").mockResolvedValue({ logs: [] } as never);
    const l = LEASE(); // deposit 10 USDC -> cap 1 USDC
    const q = (name: string, fee = 0) => ({ name, fee });
    const cases: [ReturnType<typeof q>[], RegExp][] = [
      [[], /at least one/],
      [Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => q(`C${i}`)), new RegExp(`at most ${MAX_CANDIDATES}`)],
      [[q("Acme"), q("  ACME ")], /twice/],
      [[q("Ac\u200Bme")], /invisible/],
      [[q("x".repeat(65))], /limit/],
      [[q("Acme", 1_000_001)], /tenth of the deposit/],
      [[q("Acme", -1)], /whole amount/],
    ];
    for (const [list, re] of cases) await expect(Promise.resolve().then(() => chain.proposeAppraisers(me, l, list))).rejects.toThrow(re);
    expect(build).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
  });
});

describe("pickAppraiser", () => {
  it("sends the display name and no appraiser account", async () => {
    const tx = await capture((chain, me) => chain.pickAppraiser(me, LEASE(), " Acme   Wycena "));
    expect(Object.keys(metas(tx, "pick_appraiser"))).toEqual(["party", "lease", "dispute"]);
    expect(tx.instructions[0].data.includes(Buffer.from("Acme Wycena"))).toBe(true);
  });
  it("refuses an unusable name before sending", async () => {
    vi.stubEnv("VITE_API", "");
    const chain = await load();
    const me = chain.makeMe(localWallet("tenant"));
    expect(() => chain.pickAppraiser(me, LEASE(), "")).toThrow(/Type the/);
  });
});

describe("proposeAppraiserKey / confirmAppraiserKey", () => {
  it("both take the wallet as an argument and the same three accounts", async () => {
    for (const [fn, ixName] of [["proposeAppraiserKey", "propose_appraiser_key"], ["confirmAppraiserKey", "confirm_appraiser_key"]] as const) {
      const tx = await capture((chain, me) => chain[fn](me, LEASE(), stranger));
      expect(Object.keys(metas(tx, ixName))).toEqual(["party", "lease", "dispute"]);
      expect(tx.instructions[0].data.subarray(8).equals(new PublicKey(stranger).toBuffer())).toBe(true);
    }
  });
  it("refuses a bad address, the all-zero key and either party before sending", async () => {
    vi.stubEnv("VITE_API", "");
    const chain = await load();
    const me = chain.makeMe(localWallet("tenant"));
    const l = LEASE();
    for (const fn of [chain.proposeAppraiserKey, chain.confirmAppraiserKey]) {
      expect(() => fn(me, l, "not a key")).toThrow(/not a valid account address/);
      expect(() => fn(me, l, PublicKey.default.toBase58())).toThrow(/all-zero/);
      expect(() => fn(me, l, l.landlord)).toThrow(/landlord or tenant/);
      expect(() => fn(me, l, l.tenant)).toThrow(/landlord or tenant/);
    }
  });
});

describe("submitVerdict", () => {
  it("puts the idempotent create-ATA first, paid by the appraiser when unsponsored, then submit_verdict", async () => {
    const appraiser = localWallet("landlord"); // any wallet that is not a party to the lease
    const l = lease({ status: "mediation", landlord: anchor.web3.Keypair.generate().publicKey.toBase58(), tenant: anchor.web3.Keypair.generate().publicKey.toBase58() });
    const chain = await load();
    const me = chain.makeMe(appraiser);
    let captured: anchor.web3.Transaction | undefined;
    vi.spyOn(anchor.AnchorProvider.prototype, "simulate").mockImplementation((async (tx: unknown) => ((captured ??= tx as anchor.web3.Transaction), { logs: [] })) as never);
    vi.spyOn(anchor.AnchorProvider.prototype, "sendAndConfirm").mockResolvedValue("SIG" as never);
    await chain.submitVerdict(me, l, 1_000_000);
    const [ata, verdict] = captured!.instructions;
    expect(ata.programId.toBase58()).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    expect(ata.keys[0].pubkey.toBase58()).toBe(me.key.toBase58()); // payer
    expect(ata.data[0]).toBe(1); // CreateIdempotent
    expect(verdict.programId.toBase58()).toBe(PROGRAM_ID.toBase58());
    const order = accountOrder("submit_verdict");
    // the appraiser's token account is the one the create-ATA instruction opens
    expect(verdict.keys[order.indexOf("appraiser_ata")].pubkey.toBase58()).toBe(ata.keys[1].pubkey.toBase58());
    expect(verdict.keys[order.indexOf("appraiser")].pubkey.toBase58()).toBe(me.key.toBase58());
    expect(verdict.keys[order.indexOf("dispute")].pubkey.toBase58()).toBe(disputePda(new PublicKey(l.address)).toBase58());
    expect(verdict.keys[order.indexOf("tenant")].pubkey.toBase58()).toBe(l.tenant);
  });
  it("refuses a verdict above the deposit or a fractional one", async () => {
    const chain = await load();
    const me = chain.makeMe(localWallet("tenant"));
    await expect(chain.submitVerdict(me, LEASE(), 10_000_001)).rejects.toThrow(/more than the deposit/);
    await expect(chain.submitVerdict(me, LEASE(), 1.5)).rejects.toThrow(/whole amount/);
  });
});

describe("IDL-derived layout", () => {
  it("Dispute is 891 bytes and the appraiser field sits at 842", async () => {
    const chain = await load();
    expect(chain.accountSize("Dispute")).toBe(891);
    expect(chain.fieldOffset("Dispute", "appraiser")).toBe(842);
    expect(chain.accountSize("Lease")).toBe(218);
    expect(chain.fieldOffset("Lease", "dispute_rounds")).toBe(217);
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
