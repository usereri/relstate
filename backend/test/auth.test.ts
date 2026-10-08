import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.ADMIN_TOKEN = "";
const auth = await import("../src/auth.ts");
const { AuthError, assertAdmin, createSessionToken, sessionFromAuthorizationHeader, verifySessionToken } = auth;

const secret = Buffer.from("test-secret-test-secret-test-secret");
const NOW = 1_700_000_000_000;
const make = (wallet = "WalletA", ttlSeconds = 60) => createSessionToken(wallet, { secret, ttlSeconds, now: NOW });

describe("session tokens", () => {
  it("round-trips", () => {
    const { token, expiresAt } = make();
    assert.equal(expiresAt, NOW / 1000 + 60);
    assert.deepEqual(verifySessionToken(token, { secret, now: NOW }), { wallet: "WalletA", expiresAt });
  });

  it("works with the process secret when none is given", () => {
    const { token } = createSessionToken("W");
    assert.equal(verifySessionToken(token).wallet, "W");
  });

  it("refuses an empty wallet", () => {
    assert.throws(() => createSessionToken("  ", { secret }), AuthError);
  });

  it("expires", () => {
    const { token, expiresAt } = make();
    assert.doesNotThrow(() => verifySessionToken(token, { secret, now: expiresAt * 1000 - 1 }));
    assert.throws(() => verifySessionToken(token, { secret, now: expiresAt * 1000 }), /expired/);
  });

  it("rejects the wrong secret", () => {
    const { token } = make();
    assert.throws(() => verifySessionToken(token, { secret: Buffer.from("another-secret"), now: NOW }), /signature/);
  });

  it("rejects a tampered payload", () => {
    const { token } = make("WalletA");
    const [, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ w: "Victim", exp: NOW / 1000 + 9999 })).toString("base64url");
    assert.throws(() => verifySessionToken(`${forged}.${sig}`, { secret, now: NOW }), /signature/);
  });

  it("rejects a tampered signature", () => {
    const { token } = make();
    const flipped = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    assert.throws(() => verifySessionToken(flipped, { secret, now: NOW }), AuthError);
  });

  it("rejects a validly signed payload with the wrong shape", async () => {
    const { createHmac } = await import("node:crypto");
    const payload = Buffer.from(JSON.stringify({ w: 5, exp: "x" })).toString("base64url");
    const sig = createHmac("sha256", secret).update(payload).digest("base64url");
    assert.throws(() => verifySessionToken(`${payload}.${sig}`, { secret, now: NOW }), /malformed session payload/);
  });

  for (const bad of ["", "nodot", ".sig", "payload.", "!!!.???"]) {
    it(`rejects malformed token ${JSON.stringify(bad)}`, () => {
      assert.throws(() => verifySessionToken(bad, { secret, now: NOW }), AuthError);
    });
  }
});

describe("Authorization header", () => {
  const { token } = make();
  const opts = { now: NOW };

  it("accepts a bearer token", () => {
    // The helper verifies against the process secret, so mint with the same one.
    const own = createSessionToken("W").token;
    assert.equal(sessionFromAuthorizationHeader(`Bearer ${own}`).wallet, "W");
    assert.equal(sessionFromAuthorizationHeader(`bearer   ${own}  `).wallet, "W");
  });

  for (const header of [undefined, null, "", "Bearer", "Bearer ", "Basic abc", "abc.def", "Token abc.def"]) {
    it(`rejects ${JSON.stringify(header)}`, () => {
      assert.throws(() => sessionFromAuthorizationHeader(header, opts), AuthError);
    });
  }

  it("rejects a token signed with another secret", () => {
    assert.throws(() => sessionFromAuthorizationHeader(`Bearer ${token}`, opts), AuthError);
  });
});

describe("assertAdmin", () => {
  it("refuses everything when ADMIN_TOKEN is unset", () => {
    assert.throws(() => assertAdmin("Bearer anything"), /not configured/);
    assert.throws(() => assertAdmin(undefined), /not configured/);
    assert.throws(() => assertAdmin("Bearer "), /not configured/);
  });
});
