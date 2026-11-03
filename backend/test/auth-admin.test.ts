import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// env.ts reads ADMIN_TOKEN once at import, so this needs its own process.
process.env.ADMIN_TOKEN = "s3cret-admin-token";
const { AuthError, assertAdmin } = await import("../src/auth.ts");

describe("assertAdmin with ADMIN_TOKEN configured", () => {
  it("accepts the right bearer token", () => {
    assert.doesNotThrow(() => assertAdmin("Bearer s3cret-admin-token"));
  });

  for (const header of [undefined, null, "", "Bearer", "Bearer wrong", "Bearer s3cret-admin-toke", "Bearer s3cret-admin-token2", "s3cret-admin-token"]) {
    it(`refuses ${JSON.stringify(header)}`, () => {
      assert.throws(() => assertAdmin(header), AuthError);
    });
  }
});
