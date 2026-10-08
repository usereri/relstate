import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LimitError, createRateLimiter, type LimitConfig } from "../src/limits.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

const config = (over: Partial<LimitConfig> = {}): LimitConfig => ({
  maxPerWalletPerHour: 3,
  maxGlobalPerHour: 5,
  maxLamportsPerWalletPerDay: 100n,
  maxLamportsGlobalPerDay: 250n,
  ...over,
});

const scope = (fn: () => unknown): "wallet" | "global" | "none" => {
  try {
    fn();
    return "none";
  } catch (e) {
    assert.ok(e instanceof LimitError);
    return e.scope;
  }
};

describe("rate limiter", () => {
  it("enforces the per-wallet hourly count", () => {
    const l = createRateLimiter(config({ maxLamportsPerWalletPerDay: 10_000n, maxLamportsGlobalPerDay: 10_000n }));
    for (let i = 0; i < 3; i++) l.reserve("a", 1n, T0 + i).commit(1n);
    assert.equal(scope(() => l.reserve("a", 1n, T0 + 10)), "wallet");
    // Another wallet is unaffected.
    assert.equal(scope(() => l.reserve("b", 1n, T0 + 10)), "none");
  });

  it("frees the hourly count once the hour has passed", () => {
    const l = createRateLimiter(config({ maxLamportsPerWalletPerDay: 10_000n, maxLamportsGlobalPerDay: 10_000n }));
    for (let i = 0; i < 3; i++) l.reserve("a", 1n, T0).commit(1n);
    assert.equal(scope(() => l.reserve("a", 1n, T0 + HOUR)), "wallet", "exactly one hour later the entries still count");
    assert.equal(scope(() => l.reserve("a", 1n, T0 + HOUR + 1)), "none");
  });

  it("enforces the global hourly count across wallets", () => {
    const l = createRateLimiter(config({ maxPerWalletPerHour: 10, maxLamportsPerWalletPerDay: 10_000n, maxLamportsGlobalPerDay: 10_000n }));
    for (let i = 0; i < 5; i++) l.reserve(`w${i}`, 1n, T0).commit(1n);
    assert.equal(scope(() => l.reserve("fresh", 1n, T0)), "global");
  });

  it("enforces the per-wallet daily lamport cap", () => {
    const l = createRateLimiter(config());
    l.reserve("a", 60n, T0).commit(60n);
    assert.equal(scope(() => l.reserve("a", 41n, T0 + 1)), "wallet");
    assert.equal(scope(() => l.reserve("a", 40n, T0 + 1)), "none", "exactly the cap is allowed");
  });

  it("enforces the global daily lamport cap", () => {
    const l = createRateLimiter(config({ maxPerWalletPerHour: 10, maxLamportsPerWalletPerDay: 200n }));
    l.reserve("a", 150n, T0).commit(150n);
    l.reserve("b", 90n, T0).commit(90n);
    assert.equal(scope(() => l.reserve("c", 11n, T0)), "global");
  });

  it("frees the daily lamport budget after a day", () => {
    const l = createRateLimiter(config());
    l.reserve("a", 100n, T0).commit(100n);
    assert.equal(scope(() => l.reserve("a", 1n, T0 + DAY)), "wallet");
    assert.equal(scope(() => l.reserve("a", 1n, T0 + DAY + 1)), "none");
  });

  it("a cancelled reservation frees its count and its lamports", () => {
    const l = createRateLimiter(config());
    const r = l.reserve("a", 100n, T0);
    assert.equal(scope(() => l.reserve("a", 1n, T0)), "wallet", "an open reservation holds its budget");
    r.cancel();
    assert.deepEqual(l.snapshot("a", T0), { walletLastHour: 0, walletLamportsLastDay: 0n, globalLastHour: 0, globalLamportsLastDay: 0n });
    assert.equal(scope(() => l.reserve("a", 100n, T0)), "none");
  });

  it("a committed reservation keeps its budget, rewritten to the actual cost", () => {
    const l = createRateLimiter(config());
    const r = l.reserve("a", 100n, T0);
    r.commit(30n);
    assert.equal(l.snapshot("a", T0).walletLamportsLastDay, 30n);
    assert.equal(l.snapshot("a", T0).walletLastHour, 1);
  });

  it("commit and cancel are one-shot: a closed reservation cannot be cancelled or re-committed", () => {
    const l = createRateLimiter(config());
    const r = l.reserve("a", 50n, T0);
    r.commit(50n);
    r.cancel();
    r.commit(1n);
    assert.equal(l.snapshot("a", T0).walletLamportsLastDay, 50n);
    const r2 = l.reserve("a", 10n, T0);
    r2.cancel();
    r2.cancel();
    r2.commit(99n);
    assert.equal(l.snapshot("a", T0).walletLamportsLastDay, 50n);
  });

  it("a rejected reserve books nothing", () => {
    const l = createRateLimiter(config());
    assert.equal(scope(() => l.reserve("a", 101n, T0)), "wallet");
    assert.equal(l.snapshot("a", T0).walletLastHour, 0);
    assert.equal(l.snapshot("a", T0).globalLastHour, 0);
  });

  it("concurrent reservations cannot both pass a cap that only fits one", () => {
    const l = createRateLimiter(config());
    const first = l.reserve("a", 60n, T0);
    assert.equal(scope(() => l.reserve("a", 60n, T0)), "wallet");
    first.commit(60n);
  });
});
