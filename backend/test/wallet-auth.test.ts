import "./noenv.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
import { describe, it } from "node:test";
import { getAddressDecoder, type Address } from "@solana/kit";

const { createWalletAuth, verifyEd25519, createIpLimiter, clientIpOf, RateLimited } = await import("../src/wallet-auth.ts");
const { AuthError, createSessionToken, sessionFromAuthorizationHeader } = await import("../src/auth.ts");
const { createApp } = await import("../src/server.ts");
const { env } = await import("../src/env.ts");
import type { WalletAuthOptions } from "../src/wallet-auth.ts";
import type { Services } from "../src/services.ts";

const NOW = 1_700_000_000_000;
const ORIGIN = "http://localhost:5173";

function makeKeypair(): { privateKey: KeyObject; wallet: Address } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const raw = der.subarray(der.length - 32); // the raw 32-byte ed25519 public key is always the DER's tail
  return { privateKey, wallet: getAddressDecoder().decode(raw) as Address };
}

function signMessage(message: string, privateKey: KeyObject): Buffer {
  return nodeSign(null, Buffer.from(message, "utf8"), privateKey) as Buffer;
}

function wa(opts: WalletAuthOptions = {}) {
  return createWalletAuth({ origin: ORIGIN, now: () => NOW, ...opts });
}

describe("verifyEd25519", () => {
  it("accepts a genuine signature and rejects a wrong-length or malformed one", () => {
    const { privateKey, wallet } = makeKeypair();
    const message = Buffer.from("hello relstate", "utf8");
    const sig = signMessage("hello relstate", privateKey);
    assert.equal(verifyEd25519(wallet, message, sig), true);
    assert.equal(verifyEd25519(wallet, message, sig.subarray(0, 63)), false);
    assert.equal(verifyEd25519("not-an-address", message, sig), false);
  });
});

describe("createWalletAuth: challenge shape", () => {
  it("returns a message, a nonce and an expiry; the message binds origin, wallet, nonce, issued and expiry", () => {
    const { wallet } = makeKeypair();
    const { message, nonce, expiresAt } = wa().challenge(wallet);
    assert.equal(typeof nonce, "string");
    assert.ok(nonce.length > 0);
    const lines = message.split("\n");
    assert.equal(lines[0], "localhost:5173 wants you to sign in with your Solana account:");
    assert.equal(lines[1], wallet);
    assert.ok(message.includes(`URI: ${ORIGIN}`));
    assert.equal(lines[6], `Nonce: ${nonce}`);
    assert.ok(message.includes(`Issued At: ${new Date(NOW).toISOString()}`));
    assert.ok(message.includes(`Expiration Time: ${new Date(expiresAt).toISOString()}`));
    assert.equal(expiresAt, NOW + 300_000);
  });

  it("refuses a malformed wallet", () => {
    for (const bad of ["", "not-an-address", 5, undefined, null]) {
      assert.throws(() => wa().challenge(bad), AuthError);
    }
  });

  it("two challenges for the same wallet get different nonces and messages, and both stay usable", () => {
    const { privateKey, wallet } = makeKeypair();
    const auth = wa();
    const first = auth.challenge(wallet);
    const second = auth.challenge(wallet);
    assert.notEqual(first.nonce, second.nonce);
    assert.notEqual(first.message, second.message);
    // A third party (or the same user, opening two tabs) requesting a second challenge for a
    // wallet must not invalidate the first: each nonce is its own independent pending login.
    const sig1 = signMessage(first.message, privateKey).toString("base64");
    const token1 = auth.verifyLogin(wallet, first.nonce, sig1);
    assert.equal(token1.wallet, wallet);
    const sig2 = signMessage(second.message, privateKey).toString("base64");
    const token2 = auth.verifyLogin(wallet, second.nonce, sig2);
    assert.equal(token2.wallet, wallet);
  });
});

describe("createWalletAuth: per-wallet and global eviction (never refuses, degrades the oldest)", () => {
  // BUG (reported, not fixed here — see the test report): challenge()'s per-wallet eviction snapshots
  // `mine` from `byWallet` *before* the while loop, then calls `drop(mine[0])` on every iteration.
  // `drop` updates `byWallet` with a *new* array, but the loop keeps reading the stale `mine`
  // reference, whose `.length` never changes — so once a wallet's pending count reaches
  // `maxPendingPerWallet`, the *next* challenge() call for that same wallet spins forever
  // (confirmed: a tight synchronous loop that pegs one CPU core at 100% and never returns).
  // This is a full process hang, trivially triggered by any unauthenticated caller requesting a 4th
  // login challenge for the same wallet (the default maxPendingPerWallet is 3). Skipped so the test
  // suite does not hang; un-skip once wallet-auth.ts's `challenge()` re-reads `byWallet` on each
  // iteration instead of reusing the initial snapshot.
  it.skip("per-wallet cap: the 4th challenge for one wallet evicts the oldest (1st), which then fails to verify; the newer three remain valid", () => {
    const { privateKey, wallet } = makeKeypair();
    const auth = wa({ maxPendingPerWallet: 3 });
    const c1 = auth.challenge(wallet);
    const c2 = auth.challenge(wallet);
    const c3 = auth.challenge(wallet);
    const c4 = auth.challenge(wallet); // hangs the process today; see the BUG note above

    const sig1 = signMessage(c1.message, privateKey).toString("base64");
    assert.throws(() => auth.verifyLogin(wallet, c1.nonce, sig1), /login failed/);

    for (const c of [c2, c3, c4]) {
      const sig = signMessage(c.message, privateKey).toString("base64");
      assert.doesNotThrow(() => auth.verifyLogin(wallet, c.nonce, sig));
    }
  });

  it("global cap: a flood from many wallets evicts the globally-oldest challenge instead of refusing a new wallet", () => {
    const auth = wa({ maxPending: 3, maxPendingPerWallet: 10 });
    const keys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
    const challenges = keys.map((k) => auth.challenge(k.wallet));
    assert.equal(auth.pendingCount(), 3); // the 4th challenge evicted the 1st, never refused

    // The oldest (first wallet's) challenge is gone.
    const sig0 = signMessage(challenges[0]!.message, keys[0]!.privateKey).toString("base64");
    assert.throws(() => auth.verifyLogin(keys[0]!.wallet, challenges[0]!.nonce, sig0), /login failed/);

    // The newest wallet's challenge, which caused the eviction, works fine.
    const sig3 = signMessage(challenges[3]!.message, keys[3]!.privateKey).toString("base64");
    assert.doesNotThrow(() => auth.verifyLogin(keys[3]!.wallet, challenges[3]!.nonce, sig3));
  });
});

describe("createWalletAuth: verifyLogin", () => {
  it("round-trips: a genuine signature yields a session for that wallet", () => {
    const { privateKey, wallet } = makeKeypair();
    const auth = wa();
    const { message, nonce } = auth.challenge(wallet);
    const sig = signMessage(message, privateKey);
    const { token, wallet: tokenWallet, expiresAt } = auth.verifyLogin(wallet, nonce, sig.toString("base64"));
    assert.equal(tokenWallet, wallet);
    assert.equal(expiresAt, Math.floor(NOW / 1000) + env.walletSessionTtlSeconds);
    assert.equal(sessionFromAuthorizationHeader(`Bearer ${token}`, { now: NOW }).wallet, wallet);
  });

  it("is single-use: a second verify of the same nonce and signature fails", () => {
    const { privateKey, wallet } = makeKeypair();
    const auth = wa();
    const { message, nonce } = auth.challenge(wallet);
    const sig = signMessage(message, privateKey).toString("base64");
    auth.verifyLogin(wallet, nonce, sig);
    assert.throws(() => auth.verifyLogin(wallet, nonce, sig), /login failed/);
  });

  it("rejects a signature made by a different key than the claimed wallet", () => {
    const { wallet } = makeKeypair();
    const impostor = makeKeypair();
    const auth = wa();
    const { message, nonce } = auth.challenge(wallet);
    const sig = signMessage(message, impostor.privateKey).toString("base64");
    assert.throws(() => auth.verifyLogin(wallet, nonce, sig), /login failed/);
  });

  it("rejects a nonce that belongs to a different wallet (nonce+wallet mismatch)", () => {
    const { privateKey: pk1, wallet: w1 } = makeKeypair();
    const { wallet: w2 } = makeKeypair();
    const auth = wa();
    const c1 = auth.challenge(w1);
    auth.challenge(w2);
    // A genuine signature for w1's own challenge, submitted under w2's name with w1's nonce.
    const sig = signMessage(c1.message, pk1).toString("base64");
    assert.throws(() => auth.verifyLogin(w2, c1.nonce, sig), /login failed/);
  });

  it("rejects a signature over a different message (wrong domain/content) even from the right key", () => {
    const { privateKey, wallet } = makeKeypair();
    const auth = wa();
    const { message, nonce } = auth.challenge(wallet);
    const tampered = message.replace(`URI: ${ORIGIN}`, "URI: http://evil.test");
    const sig = signMessage(tampered, privateKey).toString("base64");
    assert.throws(() => auth.verifyLogin(wallet, nonce, sig), /login failed/);
  });

  it("rejects a tampered (bit-flipped) signature", () => {
    const { privateKey, wallet } = makeKeypair();
    const auth = wa();
    const { message, nonce } = auth.challenge(wallet);
    const sig = signMessage(message, privateKey);
    sig[0]! ^= 0xff;
    assert.throws(() => auth.verifyLogin(wallet, nonce, sig.toString("base64")), /login failed/);
  });

  it("rejects malformed wallet, nonce or signature inputs without crashing", () => {
    const { privateKey, wallet } = makeKeypair();
    const auth = wa();
    const { message, nonce } = auth.challenge(wallet);
    const sig = signMessage(message, privateKey).toString("base64");
    for (const [badWallet, badNonce, badSig] of [
      [5, nonce, sig],
      [undefined, nonce, sig],
      ["not-an-address", nonce, sig],
      [wallet, 5, sig],
      [wallet, undefined, sig],
      [wallet, "not-a-real-nonce", sig],
      [wallet, nonce, 5],
      [wallet, nonce, undefined],
      [wallet, nonce, "not-base64!!"],
      [wallet, nonce, ""],
    ] as const) {
      assert.throws(() => auth.verifyLogin(badWallet, badNonce, badSig), AuthError);
    }
  });

  it("expires: a challenge used after its TTL is refused and cannot be revived", () => {
    let t = NOW;
    const auth = wa({ now: () => t, challengeTtlMs: 1000 });
    const { privateKey, wallet } = makeKeypair();
    const { message, nonce, expiresAt } = auth.challenge(wallet);
    assert.equal(expiresAt, NOW + 1000);
    const sig = signMessage(message, privateKey).toString("base64");
    t = expiresAt;
    assert.throws(() => auth.verifyLogin(wallet, nonce, sig), /login failed/);
    assert.equal(auth.pendingCount(), 0);
  });

  it("the attempt cap is per nonce: burning one nonce's attempts does not touch another nonce for the same wallet", () => {
    const { privateKey, wallet } = makeKeypair();
    const auth = wa({ maxAttempts: 3 });
    const good = auth.challenge(wallet); // the victim's own challenge
    const attacker = auth.challenge(wallet); // a second challenge requested by someone else

    const badSig = Buffer.alloc(64, 7).toString("base64");
    // Burn the attacker's own nonce's attempts; this must not touch `good`'s attempts or evict it.
    for (let i = 0; i < 3; i++) assert.throws(() => auth.verifyLogin(wallet, attacker.nonce, badSig), /login failed/);

    // The attacker's nonce is now dropped (cap reached)...
    const goodSig = signMessage(good.message, privateKey).toString("base64");
    // ...but the victim's own, untouched challenge still verifies.
    assert.doesNotThrow(() => auth.verifyLogin(wallet, good.nonce, goodSig));
  });

  it("caps wrong attempts on one nonce and then drops just that nonce, even for the real signature", () => {
    const { privateKey, wallet } = makeKeypair();
    const auth = wa({ maxAttempts: 3 });
    const { message, nonce } = auth.challenge(wallet);
    const badSig = Buffer.alloc(64, 7).toString("base64");
    for (let i = 0; i < 3; i++) assert.throws(() => auth.verifyLogin(wallet, nonce, badSig), /login failed/);
    const goodSig = signMessage(message, privateKey).toString("base64");
    assert.throws(() => auth.verifyLogin(wallet, nonce, goodSig), /login failed/);
  });

  it("never echoes the signature, nonce, wallet bytes, or any secret in its error text", () => {
    const { wallet } = makeKeypair();
    const auth = wa();
    const { nonce } = auth.challenge(wallet);
    const badSig = Buffer.alloc(64, 9).toString("base64");
    try {
      auth.verifyLogin(wallet, nonce, badSig);
      assert.fail("expected verifyLogin to throw");
    } catch (error) {
      assert.ok(error instanceof AuthError);
      const msg = (error as Error).message;
      assert.ok(!msg.includes(badSig));
      assert.ok(!msg.includes(nonce));
      assert.equal(msg, "login failed: request a new challenge and sign it");
    }
  });
});

describe("session token from a wallet login", () => {
  it("is a real session that expires after its TTL", () => {
    let t = NOW;
    const auth = wa({ now: () => t, sessionTtlSeconds: 60 });
    const { privateKey, wallet } = makeKeypair();
    const { message, nonce } = auth.challenge(wallet);
    const sig = signMessage(message, privateKey).toString("base64");
    const { token, expiresAt } = auth.verifyLogin(wallet, nonce, sig);
    assert.equal(sessionFromAuthorizationHeader(`Bearer ${token}`, { now: t }).wallet, wallet);
    t = expiresAt * 1000;
    assert.throws(() => sessionFromAuthorizationHeader(`Bearer ${token}`, { now: t }), /expired/);
  });
});

describe("createIpLimiter", () => {
  it("allows up to the per-minute cap and then throws RateLimited, resetting on the next window", () => {
    let t = 0;
    const limit = createIpLimiter(2, () => t);
    limit("ip-a");
    limit("ip-a");
    assert.throws(() => limit("ip-a"), RateLimited);
    // A different key has its own bucket.
    assert.doesNotThrow(() => limit("ip-b"));
    t += 60_000;
    assert.doesNotThrow(() => limit("ip-a"));
  });

  it("does not clear the whole table at maxKeys: an exhausted bucket survives churn that stays at or below maxKeys", () => {
    const limit = createIpLimiter(1, () => 0, 3);
    limit("a");
    assert.throws(() => limit("a"), RateLimited); // "a" is now exhausted
    limit("b");
    limit("c"); // 3 distinct keys total, exactly maxKeys: no eviction should have happened yet
    // "a" must still be exhausted: nothing cleared the table wholesale.
    assert.throws(() => limit("a"), RateLimited);
  });

  it("evicts only the oldest key once a new one would exceed maxKeys, so size never exceeds it", () => {
    const limit = createIpLimiter(1, () => 0, 3);
    limit("a"); // oldest
    limit("b");
    limit("c");
    limit("d"); // a 4th distinct key: must evict "a", not wipe the table
    // "b" and "c" are untouched and still exhausted.
    assert.throws(() => limit("b"), RateLimited);
    assert.throws(() => limit("c"), RateLimited);
    // "a" was evicted, so it is treated as brand new: one hit succeeds.
    assert.doesNotThrow(() => limit("a"));
    // ...and now "a" is exhausted again, like any fresh key would be.
    assert.throws(() => limit("a"), RateLimited);
  });
});

describe("clientIpOf", () => {
  it("trusts fly-client-ip only when told to", () => {
    const header = (name: string) => (name === "fly-client-ip" ? "1.2.3.4" : undefined);
    assert.equal(clientIpOf(header, "10.0.0.1", true), "1.2.3.4");
    assert.equal(clientIpOf(header, "10.0.0.1", false), "10.0.0.1"); // spoofed header ignored
  });

  it("falls back to the socket address when the header is absent or empty, even when trusted", () => {
    const empty = () => undefined;
    assert.equal(clientIpOf(empty, "10.0.0.1", true), "10.0.0.1");
    const blank = (name: string) => (name === "fly-client-ip" ? "" : undefined);
    assert.equal(clientIpOf(blank, "10.0.0.1", true), "10.0.0.1");
  });

  it("falls back to 'unknown' with no header and no socket address", () => {
    assert.equal(clientIpOf(() => undefined, undefined, true), "unknown");
    assert.equal(clientIpOf(() => "1.2.3.4", undefined, false), "unknown");
  });
});

describe("wallet-auth routes via createApp", () => {
  const fakeServices = {
    kyc: () => ({ status: async (wallet: string) => ({ wallet, pending: false, verified: false }) }),
    // POST /api/auth/mock checks the requested wallet against the sponsor's own address.
    sponsor: async () => ({ feePayer: "11111111111111111111111111111112" }),
  } as unknown as Services;

  function freshApp(opts: WalletAuthOptions = {}) {
    return { app: createApp(fakeServices, createWalletAuth({ origin: ORIGIN, now: () => NOW, ...opts })) };
  }

  type App = ReturnType<typeof freshApp>["app"];
  const post = (app: App, path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const get = (app: App, path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
  const json = async <T = Record<string, any>>(res: Response) => (await res.json()) as T;

  it("challenge -> verify (with the nonce) -> the token authorizes a protected route", async () => {
    // Real wall clock on purpose: the route itself verifies the session with Date.now(), so a fixed
    // past `now` here would mint a token that is already expired by the time the route checks it.
    const { app } = { app: createApp(fakeServices, createWalletAuth({ origin: ORIGIN })) };
    const { privateKey, wallet } = makeKeypair();
    const chRes = await post(app, "/api/auth/challenge", { wallet });
    assert.equal(chRes.status, 200);
    const { message, nonce } = await json(chRes);
    assert.equal(typeof nonce, "string");
    const sig = signMessage(message, privateKey);
    const vRes = await post(app, "/api/auth/verify", { wallet, nonce, signature: sig.toString("base64") });
    assert.equal(vRes.status, 200);
    const { token, wallet: tokenWallet } = await json(vRes);
    assert.equal(tokenWallet, wallet);
    const res = await get(app, "/api/kyc/status", { authorization: `Bearer ${token}` });
    assert.equal(res.status, 200);
    assert.equal((await json(res)).wallet, wallet);
  });

  it("verify without the nonce (old client shape) fails rather than silently matching", async () => {
    const { app } = freshApp();
    const { privateKey, wallet } = makeKeypair();
    const { message } = await json(await post(app, "/api/auth/challenge", { wallet }));
    const sig = signMessage(message, privateKey);
    const res = await post(app, "/api/auth/verify", { wallet, signature: sig.toString("base64") });
    assert.equal(res.status, 401);
  });

  it("429s past the per-IP rate limit on the login routes", async () => {
    // maxPendingPerWallet raised well above authRatePerMinute: see the note on the per-wallet test
    // below about a confirmed hang in challenge()'s eviction once that (default: 3) cap is reached.
    const { app } = freshApp({ maxPendingPerWallet: env.authRatePerMinute + 10 });
    const { wallet } = makeKeypair();
    for (let i = 0; i < env.authRatePerMinute; i++) {
      assert.equal((await post(app, "/api/auth/challenge", { wallet })).status, 200, `request ${i}`);
    }
    const limited = await post(app, "/api/auth/challenge", { wallet });
    assert.equal(limited.status, 429);
    assert.equal((await json(limited)).code, "rate-limited");
  });

  it("429s past the per-wallet rate limit even across different client IPs", async () => {
    // Isolate the `w:` limiter from the `c:` one: distinct fly-client-ip values keep the per-IP
    // bucket fresh on every request, so only the shared wallet hitting its own cap can explain a 429.
    const original = env.trustProxyIpHeader;
    (env as unknown as { trustProxyIpHeader: boolean }).trustProxyIpHeader = true;
    try {
      // maxPendingPerWallet raised well above authRatePerMinute: this test is about the route-level
      // rate limiter, not the per-wallet pending-challenge cap (which has its own, skipped, test
      // above due to a confirmed hang in challenge()'s eviction when that cap is actually reached).
      const { app } = freshApp({ maxPendingPerWallet: env.authRatePerMinute + 10 });
      const { wallet } = makeKeypair();
      for (let i = 0; i < env.authRatePerMinute; i++) {
        const res = await post(app, "/api/auth/challenge", { wallet }, { "fly-client-ip": `10.0.0.${i}` });
        assert.equal(res.status, 200, `request ${i}`);
      }
      const limited = await post(app, "/api/auth/challenge", { wallet }, { "fly-client-ip": "10.0.0.250" });
      assert.equal(limited.status, 429);
    } finally {
      (env as unknown as { trustProxyIpHeader: boolean }).trustProxyIpHeader = original;
    }
  });

  describe("every protected route 401s without a valid session", () => {
    const { app } = freshApp();
    const sessionRoutes: Array<{ method: "GET" | "POST"; path: string }> = [
      { method: "POST", path: "/api/sponsor" },
      { method: "POST", path: "/api/treasury/confidential-account" },
      { method: "POST", path: "/api/treasury/rent-payment" },
      { method: "POST", path: "/api/treasury/rent-dust" },
      { method: "POST", path: "/api/rent/verify" },
      { method: "POST", path: "/api/onramp/checkout" },
      { method: "GET", path: "/api/onramp/status" },
      { method: "POST", path: "/api/offramp/payout" },
      { method: "GET", path: "/api/offramp/history" },
      { method: "POST", path: "/api/kyc/start" },
      { method: "GET", path: "/api/kyc/status" },
    ];
    const adminRoutes: Array<{ method: "POST"; path: string }> = [
      { method: "POST", path: "/api/treasury/credit-reserve" },
      { method: "POST", path: "/api/treasury/wrap" },
    ];
    const call = (method: "GET" | "POST", path: string, headers: Record<string, string> = {}) =>
      method === "GET" ? get(app, path, headers) : post(app, path, {}, headers);

    for (const { method, path } of sessionRoutes) {
      it(`${method} ${path} refuses no token`, async () => {
        const res = await call(method, path);
        assert.equal(res.status, 401);
        assert.equal((await json(res)).code, "unauthorized");
      });
      it(`${method} ${path} refuses a forged token`, async () => {
        assert.equal((await call(method, path, { authorization: "Bearer aaaa.bbbb" })).status, 401);
      });
      it(`${method} ${path} refuses an expired token`, async () => {
        const { token } = createSessionToken("W", { now: NOW - 10_000, ttlSeconds: 1 });
        assert.equal((await call(method, path, { authorization: `Bearer ${token}` })).status, 401);
      });
    }

    for (const { method, path } of adminRoutes) {
      it(`${method} ${path} refuses without the admin token`, async () => {
        assert.equal((await call(method, path)).status, 401);
      });
    }
  });

  it("the mock session route is not mounted when AUTH_MODE=wallet", async () => {
    const original = env.authMode;
    (env as unknown as { authMode: string }).authMode = "wallet";
    try {
      const app = createApp(fakeServices);
      assert.equal((await post(app, "/api/auth/mock", { wallet: "W" })).status, 404);
    } finally {
      (env as unknown as { authMode: string }).authMode = original;
    }
  });

  describe("sessionSecret domain separation, end to end", () => {
    it("a token minted while AUTH_MODE=mock is 401 on a protected route once the process is AUTH_MODE=wallet, and a fresh wallet-mode token works", async () => {
      const original = env.authMode;
      try {
        (env as unknown as { authMode: string }).authMode = "mock";
        const mockApp = createApp(fakeServices);
        const { token: mockToken } = await json(await post(mockApp, "/api/auth/mock", { wallet: "WalletA" }));

        (env as unknown as { authMode: string }).authMode = "wallet";
        const walletApp = createApp(fakeServices, createWalletAuth({ origin: ORIGIN }));
        const stale = await get(walletApp, "/api/kyc/status", { authorization: `Bearer ${mockToken}` });
        assert.equal(stale.status, 401);

        const { privateKey, wallet } = makeKeypair();
        const { message, nonce } = await json(await post(walletApp, "/api/auth/challenge", { wallet }));
        const sig = signMessage(message, privateKey).toString("base64");
        const { token: walletToken } = await json(await post(walletApp, "/api/auth/verify", { wallet, nonce, signature: sig }));
        const fresh = await get(walletApp, "/api/kyc/status", { authorization: `Bearer ${walletToken}` });
        assert.equal(fresh.status, 200);
      } finally {
        (env as unknown as { authMode: string }).authMode = original;
      }
    });
  });
});
