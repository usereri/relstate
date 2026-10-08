import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { confidentialMoveAmount } from "../src/treasury.ts";

describe("confidentialMoveAmount", () => {
  it("moves everything with no holdback", () => assert.equal(confidentialMoveAmount(1000n, 0n), 1000n));
  it("keeps the holdback public", () => assert.equal(confidentialMoveAmount(1000n, 300n), 700n));
  it("moves nothing when the holdback equals the total", () => assert.equal(confidentialMoveAmount(1000n, 1000n), 0n));
  it("throws when the holdback exceeds the total", () => assert.throws(() => confidentialMoveAmount(1000n, 1001n), /exceeds/));
  it("throws on a negative holdback", () => assert.throws(() => confidentialMoveAmount(1000n, -1n), /negative/));
});
