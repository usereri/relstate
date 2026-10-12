import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
// env.ts reads these once at import, so this file needs its own process.
process.env.ADMIN_TOKEN = "s3cret-admin-token";
const A = "EBMibFLTvr5GDpgxNqt5Gqp9B1xLMr32aNwGDJV2oGJ6";
process.env.APPRAISERS = JSON.stringify([{ name: "Rzeczoznawca A", wallet: A, fee: "2000000", default: true }]);
const { createApp } = await import("../src/server.ts");
const { createServices } = await import("../src/services.ts");
const { appraiserNameHash, hex } = await import("../src/appraisers.ts");

const app = createApp(createServices(() => {}));
const post = (body: unknown, auth?: string) =>
  app.request("/api/admin/appraiser/verdict", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });

describe("GET /api/appraisers", () => {
  it("serves the configured directory, fee as a string, with the name hash the registry must hold", async () => {
    const res = await app.request("/api/appraisers");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { appraisers: Record<string, unknown>[] };
    assert.deepEqual(body.appraisers, [{ name: "Rzeczoznawca A", wallet: A, fee: "2000000", isDefault: true, nameHash: hex(appraiserNameHash("Rzeczoznawca A")) }]);
  });
});

describe("POST /api/admin/appraiser/verdict", () => {
  it("401s without or with a wrong admin token", async () => {
    assert.equal((await post({})).status, 401);
    assert.equal((await post({}, "Bearer nope")).status, 401);
  });
  it("400s on a malformed body, before touching the chain", async () => {
    const auth = "Bearer s3cret-admin-token";
    assert.equal((await post({ lease: "x", deduction: "1" }, auth)).status, 400);
    assert.equal((await post({ lease: A, deduction: "-1" }, auth)).status, 400);
    assert.equal((await post({ lease: A, deduction: "abc" }, auth)).status, 400);
  });
  it("503s, saying why, when no appraiser key is configured", async () => {
    const res = await post({ lease: A, deduction: "1" }, "Bearer s3cret-admin-token");
    assert.equal(res.status, 503);
    assert.match(((await res.json()) as { error: string }).error, /APPRAISER_KEYPAIRS/);
  });
});
