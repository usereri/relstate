import { describe, expect, it } from "vitest";
import { CLOCK_JITTER_SECS, monotonicClock } from "../useChain";

// useChainClock itself is a hook and the suite has no renderer; this is the rule that keeps its
// output from running backwards, which is what made the answer-window bar refill at each poll.
describe("monotonicClock", () => {
  it("the first value is the estimate", () => expect(monotonicClock(undefined, 100)).toBe(100));

  it("moves forward freely", () => expect(monotonicClock(100, 101)).toBe(101));

  it("a re-base that lands a little behind keeps the last value", () => {
    expect(monotonicClock(100, 99)).toBe(100);
    expect(monotonicClock(100, 100 - CLOCK_JITTER_SECS)).toBe(100);
  });

  it("a countdown derived from it never refills across jittery polls", () => {
    const answerBy = 145;
    let shown: number | undefined;
    let lastLeft = Infinity;
    for (const estimate of [100, 101, 100, 102, 99, 103, 102]) {
      shown = monotonicClock(shown, estimate);
      const left = answerBy - shown;
      expect(left).toBeLessThanOrEqual(lastLeft);
      lastLeft = left;
    }
  });

  it("a big step back is believed: a reset chain must not leave the gate stuck", () => {
    expect(monotonicClock(100_000, 50)).toBe(50);
    expect(monotonicClock(100, 100 - CLOCK_JITTER_SECS - 1)).toBe(100 - CLOCK_JITTER_SECS - 1);
  });
});
