import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address } from "@solana/kit";
import { MAX_LIVE_PLANS, MAX_PREPARATION_TXS, PLAN_TTL_MS, contextUse, createRentPlanRegistry, type ContextUse } from "../src/rentplan.ts";
import { RejectedTransaction, inspectTransaction } from "../src/txinspect.ts";
import { build, cast, plan } from "./rentfixtures.ts";

const code = (c: string) => (e: unknown) => e instanceof RejectedTransaction && e.code === c;
const A = "ctxA" as Address;
const B = "ctxB" as Address;
const C = "ctxC" as Address;
const use = (u: Partial<ContextUse>): ContextUse => ({ created: [], touched: [], closed: [], ...u });
const create = (...a: Address[]) => use({ created: a, touched: a });
const verify = (...a: Address[]) => use({ touched: a });
const close = (...a: Address[]) => use({ touched: a, closed: a });

describe("contextUse", () => {
  it("reads created, touched and closed contexts off a real transaction", async () => {
    const c = await cast();
    const p = plan(c);
    const t = inspectTransaction(await build(c, [p.createContext(c.ctxA), p.verify(c.ctxA), p.close(c.ctxB.address)]));
    assert.deepEqual(contextUse(t), { created: [c.ctxA.address], touched: [c.ctxA.address, c.ctxB.address], closed: [c.ctxB.address] });
  });
});

describe("rent plan registry", () => {
  it("walks the real sequence and is empty afterwards", () => {
    const r = createRentPlanRegistry();
    r.admit("w", create(A), false);
    r.admit("w", create(B), false);
    r.admit("w", create(C), false);
    r.admit("w", verify(C), false);
    assert.deepEqual(r.contextsOf("w").sort(), [A, B, C]);
    r.admit("w", close(A, B, C), true);
    assert.equal(r.size(), 0);
    assert.deepEqual(r.contextsOf("w"), []);
  });

  it("refuses a wallet-less transaction, foreign contexts and reuse", () => {
    const r = createRentPlanRegistry();
    assert.throws(() => r.admit("w", use({}), false), code("no-wallet-relation"));
    r.admit("w", create(A), false);
    assert.throws(() => r.admit("x", verify(A), false), code("foreign-context"));
    assert.throws(() => r.admit("x", close(A), true), code("foreign-context"));
    assert.throws(() => r.admit("x", create(A), false), code("context-reused"));
    assert.throws(() => r.admit("w", create(A), false), code("context-reused"));
    assert.throws(() => r.admit("w", verify(B), false), code("foreign-context"));
    assert.deepEqual(r.contextsOf("w"), [A]);
  });

  it("refuses a replayed verify once the plan is spent", () => {
    const r = createRentPlanRegistry();
    r.admit("w", create(A), false);
    r.admit("w", close(A), true);
    assert.throws(() => r.admit("w", verify(A), false), code("foreign-context"));
    r.admit("w", create(A), false); // spent accounts can be created afresh
  });

  it("does not let a failed admission change anything", () => {
    const r = createRentPlanRegistry();
    r.admit("w", create(A), false);
    assert.throws(() => r.admit("w", { created: [B], touched: [B, C], closed: [] }, false), code("foreign-context"));
    assert.deepEqual(r.contextsOf("w"), [A]);
    r.admit("w", create(B), false); // B was not claimed by the refused attempt
  });

  it("undo restores creates, consumed closes and a brand-new plan", () => {
    const r = createRentPlanRegistry();
    const undoCreate = r.admit("w", create(A), false);
    undoCreate();
    assert.equal(r.size(), 0);
    r.admit("x", create(A), false); // A is free again
    r.admit("w", create(B), false);
    const undoClose = r.admit("w", close(B), true);
    assert.deepEqual(r.contextsOf("w"), []);
    undoClose();
    assert.deepEqual(r.contextsOf("w"), [B]);
    assert.throws(() => r.admit("x", verify(B), false), code("foreign-context")); // B owned by w again
    r.admit("w", close(B), true);
  });

  it("caps preparation transactions per plan; the wallet-signed one is exempt", () => {
    const r = createRentPlanRegistry();
    r.admit("w", create(A), false);
    for (let i = 1; i < MAX_PREPARATION_TXS; i++) r.admit("w", verify(A), false);
    assert.throws(() => r.admit("w", verify(A), false), code("plan-full"));
    r.admit("w", close(A), true);
    // A new plan starts fresh.
    r.admit("w", create(A), false);
  });

  it("expires a plan after the TTL and frees its contexts", () => {
    let t = 1_000;
    const r = createRentPlanRegistry(() => t);
    r.admit("w", create(A), false);
    t += PLAN_TTL_MS; // exactly the TTL is still live
    r.admit("w", verify(A), false);
    t += 1;
    assert.throws(() => r.admit("w", verify(A), false), code("foreign-context"));
    assert.equal(r.size(), 0);
    r.admit("x", create(A), false); // another wallet may now create it
  });

  it("keeps wallets' plans independent, including their preparation counts", () => {
    const r = createRentPlanRegistry();
    r.admit("w", create(A), false);
    for (let i = 1; i < MAX_PREPARATION_TXS; i++) r.admit("w", verify(A), false);
    r.admit("x", create(B), false);
    assert.equal(r.size(), 2);
    assert.throws(() => r.admit("w", verify(A), false), code("plan-full"));
    r.admit("x", verify(B), false);
  });
});

describe("rent plan registry: rollback and bounds", () => {
  const X = "ctxX" as Address;
  const Y = "ctxY" as Address;

  it("a context created and closed in one transaction nets out, and undo leaves the address free", () => {
    const r = createRentPlanRegistry();
    const undo = r.admit("w", { created: [A], touched: [A], closed: [A] }, false);
    assert.equal(r.ownerOf(A), undefined);
    undo();
    assert.equal(r.ownerOf(A), undefined);
    assert.equal(r.size(), 0, "no empty plan stranded");
    r.admit("x", create(A), false);
    assert.equal(r.ownerOf(A), "x");
  });

  it("leaves no owner entry behind after the TTL sweep", () => {
    let t = 0;
    const r = createRentPlanRegistry(() => t);
    r.admit("w", create(A, B), false);
    r.admit("v", create(C), false);
    t += PLAN_TTL_MS + 1;
    assert.throws(() => r.admit("z", use({}), false), code("no-wallet-relation")); // any admission sweeps
    for (const c of [A, B, C]) assert.equal(r.ownerOf(c), undefined);
    assert.equal(r.size(), 0);
  });

  it("undoing one request leaves a concurrent request's context and the plan alive", () => {
    const r = createRentPlanRegistry();
    const undoA = r.admit("w", create(X), false);
    r.admit("w", create(Y), false);
    undoA();
    assert.equal(r.ownerOf(X), undefined);
    assert.equal(r.ownerOf(Y), "w");
    assert.deepEqual(r.contextsOf("w"), [Y]);
    assert.equal(r.size(), 1);
  });

  it("a second undo is a no-op and resurrects nothing", () => {
    const r = createRentPlanRegistry();
    const undoA = r.admit("w", create(X), false);
    const undoB = r.admit("w", create(Y), false);
    undoA();
    undoB();
    undoA();
    assert.equal(r.size(), 0);
    assert.equal(r.ownerOf(X), undefined);
    assert.equal(r.ownerOf(Y), undefined);
    // ...and it does not undo someone else's later use of the same address.
    r.admit("x", create(X), false);
    undoA();
    assert.equal(r.ownerOf(X), "x");
  });

  it("undoing the final transaction re-registers consumed contexts only if nobody claimed the address", () => {
    const r = createRentPlanRegistry();
    r.admit("w", create(X, Y), false);
    const undoFinal = r.admit("w", close(X, Y), true);
    assert.equal(r.size(), 0);
    assert.equal(r.ownerOf(X), undefined);
    undoFinal();
    assert.equal(r.ownerOf(X), "w");
    assert.equal(r.ownerOf(Y), "w");

    const q = createRentPlanRegistry();
    q.admit("w", create(X, Y), false);
    const undo = q.admit("w", close(X, Y), true);
    q.admit("x", create(X), false); // freed by the close, claimed by another wallet
    undo();
    assert.equal(q.ownerOf(X), "x", "the other wallet keeps it");
    assert.equal(q.ownerOf(Y), "w");
    assert.deepEqual(q.contextsOf("w"), [Y]);
  });

  it("refuses a new plan's create at MAX_LIVE_PLANS but not existing wallets", () => {
    const r = createRentPlanRegistry();
    for (let i = 0; i < MAX_LIVE_PLANS; i++) r.admit(`w${i}`, create(`c${i}` as Address), false);
    assert.equal(r.size(), MAX_LIVE_PLANS);
    assert.throws(() => r.admit("new", create("cNew" as Address), false), code("registry-full"));
    assert.equal(r.size(), MAX_LIVE_PLANS);
    r.admit("w0", create("cMore" as Address), false);
    r.admit("w1", verify("c1" as Address), false);
    r.admit("w2", close("c2" as Address), true); // finishing a plan is never blocked
  });

  it("counts a wallet-signed transaction that creates a context as a preparation", () => {
    const r = createRentPlanRegistry();
    for (let i = 0; i < MAX_PREPARATION_TXS; i++) r.admit("w", create(`s${i}` as Address), true);
    assert.throws(() => r.admit("w", create("s-last" as Address), true), code("plan-full"));
    // A signed transaction that creates nothing is the final one, not a preparation.
    r.admit("w", close("s0" as Address), true);
  });
});
