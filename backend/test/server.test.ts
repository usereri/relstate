import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// env.ts is read once at import; noenv.ts already blanked every secret.
const { createApp } = await import("../src/server.ts");
const { createSessionToken } = await import("../src/auth.ts");
const app = createApp();

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("server (mock mode, no secrets)", () => {
  it("GET /health is 200 and reports ephemeral keys", async () => {
    const res = await app.request("/health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.mode, "mock");
    assert.deepEqual([...(body.ephemeralKeys as string[])].sort(), ["attestationIssuer", "feePayer", "treasury"]);
    assert.equal(body.rusdcMint, null);
    assert.equal(body.auditorConfigured, false);
  });

  it("/health never leaks a secret", async () => {
    const text = await (await app.request("/health")).text();
    assert.doesNotMatch(text, /api-key|secret|ikm/i);
  });

  it("POST /api/sponsor without a token is 401", async () => {
    const res = await post("/api/sponsor", { txBase64: "AAAA" });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, "unauthorized");
  });

  it("POST /api/sponsor with a forged token is 401", async () => {
    const res = await post("/api/sponsor", { txBase64: "AAAA" }, { authorization: "Bearer aaaa.bbbb" });
    assert.equal(res.status, 401);
  });

  it("POST /api/sponsor with a valid token but a malformed body is 400", async () => {
    const { token } = createSessionToken("SomeWallet");
    const auth = { authorization: `Bearer ${token}` };
    for (const body of ["not json", "{}", JSON.stringify({ txBase64: "" }), JSON.stringify({ txBase64: 5 })]) {
      const res = await post("/api/sponsor", body, auth);
      assert.equal(res.status, 400, body);
      assert.equal(((await res.json()) as { code: string }).code, "malformed-body");
    }
  });

  it("POST /api/sponsor with garbage transaction bytes is a 400 rejection, not a 500", async () => {
    const { token } = createSessionToken("SomeWallet");
    const res = await post("/api/sponsor", { txBase64: "AAAA" }, { authorization: `Bearer ${token}` });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "malformed");
  });

  it("POST /api/auth/mock issues a session that /api/sponsor then accepts past auth", async () => {
    const res = await post("/api/auth/mock", { wallet: "W1" });
    assert.equal(res.status, 200);
    const { token } = (await res.json()) as { token: string };
    const next = await post("/api/sponsor", { txBase64: "AAAA" }, { authorization: `Bearer ${token}` });
    assert.equal(next.status, 400, "got past auth and failed on the transaction");
  });

  it("POST /api/auth/mock requires a wallet", async () => {
    assert.equal((await post("/api/auth/mock", { wallet: "  " })).status, 400);
    assert.equal((await post("/api/auth/mock", "nope")).status, 400);
  });

  it("GET /api/sponsor reports the fee payer and that nothing is broadcast with an ephemeral key", async () => {
    const res = await app.request("/api/sponsor");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { feePayer: string; ephemeral: boolean; broadcast: boolean };
    assert.match(body.feePayer, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    assert.equal(body.ephemeral, true);
    assert.equal(body.broadcast, false);
  });

  it("unknown route is 404", async () => {
    const res = await app.request("/nope");
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, "not-found");
  });

  it("GET /api/treasury/invariant is 503 when RUSDC_MINT is unset", async () => {
    const res = await app.request("/api/treasury/invariant");
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { code: string }).code, "unavailable");
  });

  it("admin routes refuse when ADMIN_TOKEN is unset", async () => {
    const res = await post("/api/treasury/credit-reserve", { amount: "1" }, { authorization: "Bearer anything" });
    assert.equal(res.status, 401);
  });

  it("the confidential-account route needs a session", async () => {
    assert.equal((await post("/api/treasury/confidential-account", { txBase64: "AAAA" })).status, 401);
  });
});
