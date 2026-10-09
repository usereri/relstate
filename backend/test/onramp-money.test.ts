import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OnrampError, createDailyCap } from "../src/providers/onramp.ts";
import {
  formatPln,
  formatScaled,
  formatUsdc,
  parsePln,
  parseRate,
  parseScaled,
  parseUsdc,
  plnToUsdc,
  usdcToPln,
} from "../src/providers/money.ts";

describe("parseScaled", () => {
  it("accepts integers and scales them", () => {
    assert.equal(parseScaled("400", 2, "x"), 40000n);
    assert.equal(parseScaled("0", 2, "x"), 0n);
  });

  it("accepts short fractions and pads them", () => {
    assert.equal(parseScaled("12.5", 2, "x"), 1250n);
    assert.equal(parseScaled("4.30", 6, "x"), 4_300_000n);
    assert.equal(parseScaled(12.5, 2, "x"), 1250n);
  });

  it("trims surrounding whitespace on strings", () => {
    assert.equal(parseScaled("  7 ", 2, "x"), 700n);
  });

  for (const bad of ["1e3", "1E3", "-1", "-0.5", "+1", "NaN", "Infinity", "", "   ", "1.", ".5", "1,5", "0x10", "1 000"]) {
    it(`rejects ${JSON.stringify(bad)}`, () => assert.throws(() => parseScaled(bad, 2, "amount"), /amount/));
  }

  it("rejects a number that stringifies to exponent form", () => {
    assert.throws(() => parseScaled(1e21, 2, "x"));
    assert.throws(() => parseScaled(Number.NaN, 2, "x"));
    assert.throws(() => parseScaled(Number.POSITIVE_INFINITY, 2, "x"));
  });

  it("rejects more decimals than the unit has", () => {
    assert.throws(() => parseScaled("1.234", 2, "x"), /decimal places/);
    assert.equal(parseScaled("1.23", 2, "x"), 123n);
  });

  it("names the field in the error", () => {
    assert.throws(() => parsePln("abc", "amountPln"), /amountPln/);
  });
});

describe("formatting", () => {
  it("renders every place exactly", () => {
    assert.equal(formatScaled(5n, 2), "0.05");
    assert.equal(formatScaled(0n, 2), "0.00");
    assert.equal(formatScaled(123n, 0), "123");
    assert.equal(formatScaled(-150n, 2), "-1.50");
    assert.equal(formatPln(40000n), "400.00");
    assert.equal(formatUsdc(93_023_255n), "93.023255");
    assert.equal(formatUsdc(1n), "0.000001");
  });

  it("round-trips through parse", () => {
    assert.equal(formatPln(parsePln("1234.56")), "1234.56");
    assert.equal(formatUsdc(parseUsdc("0.1")), "0.100000");
  });
});

describe("plnToUsdc / usdcToPln", () => {
  const rate = parseRate("4.30");

  it("floors 400.00 PLN at 4.30 to exactly 93023255 base units", () => {
    assert.equal(plnToUsdc(40000n, rate), 93_023_255n);
  });

  it("never mints more than the fiat covers", () => {
    const minted = plnToUsdc(40000n, rate);
    // minted * rate must not exceed the PLN paid (in matching scale)
    assert.ok(minted * rate <= 40000n * 10n ** 6n * 10n ** 6n / 100n);
  });

  it("converts back to within a grosz", () => {
    const back = usdcToPln(plnToUsdc(40000n, rate), rate);
    assert.ok(back <= 40000n && 40000n - back <= 1n, `got ${back}`);
  });

  it("throws on a zero or negative rate", () => {
    assert.throws(() => plnToUsdc(100n, 0n), /greater than zero/);
    assert.throws(() => plnToUsdc(100n, -1n), /greater than zero/);
    assert.throws(() => usdcToPln(100n, 0n), /greater than zero/);
  });

  it("throws on a negative amount", () => {
    assert.throws(() => plnToUsdc(-1n, rate));
    assert.throws(() => usdcToPln(-1n, rate));
  });
});

describe("createDailyCap", () => {
  const A = "wallet-a";
  const B = "wallet-b";

  it("passes under the cap", () => {
    const cap = createDailyCap(100n);
    cap.record(A, 40n, 0);
    assert.doesNotThrow(() => cap.check(A, 60n, 0));
    assert.equal(cap.remaining(A, 0), 60n);
  });

  it("throws OnrampError wallet-cap with status 429 past the cap", () => {
    const cap = createDailyCap(100n);
    cap.record(A, 40n, 0);
    assert.throws(
      () => cap.check(A, 61n, 0),
      (e: unknown) => e instanceof OnrampError && e.code === "wallet-cap" && e.status === 429,
    );
  });

  it("a single amount above the cap is refused on an empty wallet", () => {
    assert.throws(() => createDailyCap(100n).check(A, 101n, 0), /daily cap/);
  });

  it("expires the window", () => {
    const day = 86_400_000;
    const cap = createDailyCap(100n);
    cap.record(A, 100n, 0);
    assert.throws(() => cap.check(A, 1n, day));
    assert.doesNotThrow(() => cap.check(A, 100n, day + 1));
    assert.equal(cap.used(A, day + 1), 0n);
  });

  it("is per wallet", () => {
    const cap = createDailyCap(100n);
    cap.record(A, 100n, 0);
    assert.doesNotThrow(() => cap.check(B, 100n, 0));
    assert.equal(cap.remaining(B, 0), 100n);
  });
});
