import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address } from "@solana/kit";
import { MAX_PREPARATION_TXS, PLAN_TTL_MS, contextUse, createRentPlanRegistry, type ContextUse } from "../src/rentplan.ts";
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
