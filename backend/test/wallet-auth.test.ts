import "./noenv.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
import { describe, it } from "node:test";
import { getAddressDecoder, type Address } from "@solana/kit";

const { createWalletAuth, verifyEd25519, createIpLimiter, RateLimited } = await import("../src/wallet-auth.ts");
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

describe("createWalletAuth: challenge", () => {
  it("binds origin, wallet, nonce, issued and expiry into the message", () => {
    const { wallet } = makeKeypair();
    const { message, expiresAt } = wa().challenge(wallet);
    const lines = message.split("\n");
    assert.equal(lines[0], "localhost:5173 wants you to sign in with your Solana account:");
    assert.equal(lines[1], wallet);
    assert.ok(message.includes(`URI: ${ORIGIN}`));
    assert.ok(/Nonce: \S+/.test(message));
    assert.ok(message.includes(`Issued At: ${new Date(NOW).toISOString()}`));
    assert.ok(message.includes(`Expiration Time: ${new Date(expiresAt).toISOString()}`));
    assert.equal(expiresAt, NOW + 300_000);
  });

  it("refuses a malformed wallet", () => {
    for (const bad of ["", "not-an-address", 5, undefined, null]) {
      assert.throws(() => wa().challenge(bad), AuthError);
    }
  });

  it("a new challenge for the same wallet replaces the old one", () => {
    const { privateKey, wallet } = makeKeypair();
    const auth = wa();
    const first = auth.challenge(wallet);
    const second = auth.challenge(wallet);
    assert.notEqual(first.message, second.message);
    // A signature over the superseded message no longer verifies: only the latest challenge is live.
    const staleSig = signMessage(first.message, privateKey);
    assert.throws(() => auth.verifyLogin(wallet, staleSig.toString("base64")), /login failed/);
  });

  it("refuses a new challenge once the pending pool is full, but still issues one for a wallet already pending", () => {
    const auth = wa({ maxPending: 1 });
    const { wallet: w1 } = makeKeypair();
    const { wallet: w2 } = makeKeypair();
    auth.challenge(w1);
    assert.throws(() => auth.challenge(w2), /too many pending/);
    assert.doesNotThrow(() => auth.challenge(w1));
  });
});

describe("createWalletAuth: verifyLogin", () => {
  it("round-trips: a genuine signature yields a session for that wallet", () => {
    const { privateKey, wallet } = makeKeypair();
    const auth = wa();
    const { message } = auth.challenge(wallet);
    const sig = signMessage(message, privateKey);
    const { token, wallet: tokenWallet, expiresAt } = auth.verifyLogin(wallet, sig.toString("base64"));
    assert.equal(tokenWallet, wallet);
    assert.equal(expiresAt, Math.floor(NOW / 1000) + env.walletSessionTtlSeconds);
    assert.equal(sessionFromAuthorizationHeader(`Bearer ${token}`, { now: NOW }).wallet, wallet);
  });

  it("is single-use: a second verify of the same signature fails", () => {
    const { privateKey, wallet } = makeKeypair();
    const auth = wa();
    const { message } = auth.challenge(wallet);
    const sig = signMessage(message, privateKey).toString("base64");
    auth.verifyLogin(wallet, sig);
    assert.throws(() => auth.verifyLogin(wallet, sig), /login failed/);
  });

  it("rejects a signature made by a different key than the claimed wallet", () => {
    const { wallet } = makeKeypair();
    const impostor = makeKeypair();
    const auth = wa();
    const { message } = auth.challenge(wallet);
    const sig = signMessage(message, impostor.privateKey).toString("base64");
    assert.throws(() => auth.verifyLogin(wallet, sig), /login failed/);
  });

  it("rejects a signature over a different message (wrong domain/content) even from the right key", () => {
    const { privateKey, wallet } = makeKeypair();
    const auth = wa();
    const { message } = auth.challenge(wallet);
    const tampered = message.replace(`URI: ${ORIGIN}`, "URI: http://evil.test");
    const sig = signMessage(tampered, privateKey).toString("base64");
    assert.throws(() => auth.verifyLogin(wallet, sig), /login failed/);
  });

  it("rejects a tampered (bit-flipped) signature", () => {
    const { privateKey, wallet } = makeKeypair();
    const auth = wa();
    const { message } = auth.challenge(wallet);
    const sig = signMessage(message, privateKey);
    sig[0]! ^= 0xff;
    assert.throws(() => auth.verifyLogin(wallet, sig.toString("base64")), /login failed/);
  });

  it("rejects malformed wallet or signature inputs without crashing", () => {
    const { privateKey, wallet } = makeKeypair();
    const auth = wa();
    const { message } = auth.challenge(wallet);
    const sig = signMessage(message, privateKey).toString("base64");
    for (const [badWallet, badSig] of [
      [5, sig],
      [undefined, sig],
      ["not-an-address", sig],
      [wallet, 5],
      [wallet, undefined],
      [wallet, "not-base64!!"],
      [wallet, ""],
    ] as const) {
      assert.throws(() => auth.verifyLogin(badWallet, badSig), AuthError);
    }
  });

  it("expires: a challenge used after its TTL is refused and cannot be revived", () => {
    let t = NOW;
    const auth = wa({ now: () => t, challengeTtlMs: 1000 });
    const { privateKey, wallet } = makeKeypair();
    const { message, expiresAt } = auth.challenge(wallet);
    assert.equal(expiresAt, NOW + 1000);
    const sig = signMessage(message, privateKey).toString("base64");
    t = expiresAt;
    assert.throws(() => auth.verifyLogin(wallet, sig), /login failed/);
    assert.equal(auth.pendingCount(), 0);
  });

  it("caps wrong attempts and then drops the challenge, even for the real signature", () => {
    const { privateKey, wallet } = makeKeypair();
    const auth = wa({ maxAttempts: 3 });
    const { message } = auth.challenge(wallet);
    const badSig = Buffer.alloc(64, 7).toString("base64");
    for (let i = 0; i < 3; i++) assert.throws(() => auth.verifyLogin(wallet, badSig), /login failed/);
    assert.equal(auth.pendingCount(), 0);
    const goodSig = signMessage(message, privateKey).toString("base64");
    assert.throws(() => auth.verifyLogin(wallet, goodSig), /login failed/);
  });

  it("never echoes the signature, wallet bytes, or any secret in its error text", () => {
    const { wallet } = makeKeypair();
    const auth = wa();
    auth.challenge(wallet);
    const badSig = Buffer.alloc(64, 9).toString("base64");
    try {
      auth.verifyLogin(wallet, badSig);
      assert.fail("expected verifyLogin to throw");
    } catch (error) {
      assert.ok(error instanceof AuthError);
      const msg = (error as Error).message;
      assert.ok(!msg.includes(badSig));
      assert.equal(msg, "login failed: request a new challenge and sign it");
    }
  });
});

describe("session token from a wallet login", () => {
  it("is a real session that expires after its TTL", () => {
    let t = NOW;
    const auth = wa({ now: () => t, sessionTtlSeconds: 60 });
    const { privateKey, wallet } = makeKeypair();
    const { message } = auth.challenge(wallet);
    const sig = signMessage(message, privateKey).toString("base64");
    const { token, expiresAt } = auth.verifyLogin(wallet, sig);
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
});

describe("wallet-auth routes via createApp", () => {
  const fakeServices = {
    kyc: () => ({ status: async (wallet: string) => ({ wallet, pending: false, verified: false }) }),
  } as unknown as Services;

  function freshApp(opts: WalletAuthOptions = {}) {
    return { app: createApp(fakeServices, createWalletAuth({ origin: ORIGIN, now: () => NOW, ...opts })) };
  }

  type App = ReturnType<typeof freshApp>["app"];
  const post = (app: App, path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const get = (app: App, path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
  const json = async <T = Record<string, any>>(res: Response) => (await res.json()) as T;

  it("challenge -> verify -> the token authorizes a protected route", async () => {
    // Real wall clock on purpose: the route itself verifies the session with Date.now(), so a fixed
    // past `now` here would mint a token that is already expired by the time the route checks it.
    const { app } = { app: createApp(fakeServices, createWalletAuth({ origin: ORIGIN })) };
    const { privateKey, wallet } = makeKeypair();
    const chRes = await post(app, "/api/auth/challenge", { wallet });
    assert.equal(chRes.status, 200);
    const { message } = await json(chRes);
    const sig = signMessage(message, privateKey);
    const vRes = await post(app, "/api/auth/verify", { wallet, signature: sig.toString("base64") });
    assert.equal(vRes.status, 200);
    const { token, wallet: tokenWallet } = await json(vRes);
    assert.equal(tokenWallet, wallet);
    const res = await get(app, "/api/kyc/status", { authorization: `Bearer ${token}` });
    assert.equal(res.status, 200);
    assert.equal((await json(res)).wallet, wallet);
  });

  it("429s past the per-IP rate limit on the login routes", async () => {
    const { app } = freshApp();
    const { wallet } = makeKeypair();
    for (let i = 0; i < env.authRatePerMinute; i++) {
      assert.equal((await post(app, "/api/auth/challenge", { wallet })).status, 200, `request ${i}`);
    }
    const limited = await post(app, "/api/auth/challenge", { wallet });
    assert.equal(limited.status, 429);
    assert.equal((await json(limited)).code, "rate-limited");
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
});
