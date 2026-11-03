import { describe, expect, it } from "vitest";
import { isSignature, jsonSafe, safeName } from "../utils";

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

describe("safeName", () => {
  it("strips a bidi override so a name cannot be made to read as something else", () => {
    // U+202E (RIGHT-TO-LEFT OVERRIDE) between two halves of a name.
    expect(safeName("Rzeczoznawca‮ A")).toBe("Rzeczoznawca A");
  });

  it("strips zero-width characters", () => {
    expect(safeName("Rzeczoznawca​ A")).toBe("Rzeczoznawca A");
  });

  it("a name of only invisible characters becomes ''", () => {
    expect(safeName("‮​‌")).toBe("");
  });

  it("collapses internal whitespace and trims the ends", () => {
    expect(safeName("  Rzeczoznawca   A  ")).toBe("Rzeczoznawca A");
  });

  it("truncates to max INCLUDING the ellipsis, not max + 1", () => {
    const long = "A".repeat(60);
    const got = safeName(long, 10);
    expect(got).toHaveLength(10);
    expect(got).toBe(`${"A".repeat(9)}…`);
  });

  it("leaves a normal, short name unchanged", () => {
    expect(safeName("Rzeczoznawca A")).toBe("Rzeczoznawca A");
  });
});

describe("isSignature", () => {
  it("is true for a real-shaped base58 signature", () => {
    expect(isSignature("4z6v6b8qY2VBjz3wM9Qd1z2M5N9HrW3kLQy1VXwV2b9ZqWJ9hT8d7vK3xQp1fJcA9y2wR5mX3bZ7t1nK6sD4eHg")).toBe(true);
  });

  it("is false for a string containing characters base58 excludes (0, O, I, l)", () => {
    const base = "4z6v6b8qY2VBjz3wM9Qd1z2M5N9HrW3kLQy1VXwV2b9ZqWJ9hT8d7vK3xQp1fJcA9y2wR5mX3bZ7t1nK6sD4eHg";
    expect(isSignature(`0${base.slice(1)}`)).toBe(false);
    expect(isSignature(`O${base.slice(1)}`)).toBe(false);
    expect(isSignature(`I${base.slice(1)}`)).toBe(false);
    expect(isSignature(`l${base.slice(1)}`)).toBe(false);
  });

  it("is false for a value containing URL- or markup-breaking characters", () => {
    expect(isSignature("http://evil/")).toBe(false);
    expect(isSignature('"><script>')).toBe(false);
    expect(isSignature("a:b")).toBe(false);
    expect(isSignature("has space")).toBe(false);
  });

  it("is false outside the length bounds (43-88)", () => {
    expect(isSignature("short")).toBe(false);
    expect(isSignature("A".repeat(89))).toBe(false);
    expect(isSignature("")).toBe(false);
  });
});
