import { describe, expect, it } from "vitest";
import { jsonSafe } from "../utils";

describe("jsonSafe", () => {
  it("stringifies a bigint as a plain number string", () => {
    expect(jsonSafe(5n)).toBe('"5"');
    expect(jsonSafe({ amount: 1_234_567_890_123n })).toBe('{"amount":"1234567890123"}');
  });

  it("stringifies a bigint nested inside the shape a transaction error carries", () => {
    const err = { InstructionError: [0, { Custom: 6025 }] };
    const withBigint = { err, context: { slot: 12345n } };
    expect(jsonSafe(withBigint)).toBe('{"err":{"InstructionError":[0,{"Custom":6025}]},"context":{"slot":"12345"}}');
  });

  it("behaves like JSON.stringify for ordinary values", () => {
    expect(jsonSafe({ a: 1, b: "x", c: null, d: [1, 2, 3] })).toBe(JSON.stringify({ a: 1, b: "x", c: null, d: [1, 2, 3] }));
  });
});
