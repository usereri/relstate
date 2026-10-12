import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asked, consoleErrorMessage, parseAmountInput, previewGate, verdictProblem, verdictView } from "../verdict";

describe("parseAmountInput", () => {
  it("parses whole and decimal amounts into base units", () => {
    expect(parseAmountInput("12.5")).toEqual({ base: 12_500_000 });
    expect(parseAmountInput("0")).toEqual({ base: 0 });
    expect(parseAmountInput("0.000001")).toEqual({ base: 1 }); // one base unit
  });

  it("trims leading and trailing whitespace", () => {
    expect(parseAmountInput("  12.5  ")).toEqual({ base: 12_500_000 });
  });

  it("rejects an empty or blank field with its own message, not the general one", () => {
    expect(parseAmountInput("")).toEqual({ error: expect.stringMatching(/Enter the deduction/) });
    expect(parseAmountInput("   ")).toEqual({ error: expect.stringMatching(/Enter the deduction/) });
  });

  it("rejects a negative amount with its own message, not the general one", () => {
    expect(parseAmountInput("-5")).toEqual({ error: expect.stringMatching(/cannot be negative/) });
  });

  it("rejects text that is not digits-and-one-decimal-point", () => {
    for (const bad of ["abc", "1e3", "0x10", "."]) {
      expect(parseAmountInput(bad), bad).toEqual({ error: expect.stringMatching(/digits/) });
    }
  });

  it("rejects a seventh decimal place (USDC has six)", () => {
    expect(parseAmountInput("1.2345678")).toEqual({ error: expect.stringMatching(/digits/) });
  });

  it("rejects an amount too large to be a safe integer of base units", () => {
    // 10_000_000_000 whole units * 1e6 = 1e16, past Number.MAX_SAFE_INTEGER (~9.007e15).
    expect(parseAmountInput("10000000000")).toEqual({ error: expect.stringMatching(/too large/) });
  });

  it("never returns a base alongside an error, for any rejected input", () => {
    for (const bad of ["", " ", "abc", "1e3", "0x10", "-5", "1.2345678", ".", "10000000000"]) {
      const r = parseAmountInput(bad);
      expect("base" in r, bad).toBe(false);
      expect("error" in r, bad).toBe(true);
    }
  });
});

describe("asked / previewGate", () => {
  it("authorises exactly the (lease, deductionBase) pair it was asked about", () => {
    const preview = { asked: asked("LEASE1", 100), result: { lease: "LEASE1", deduction: 100 } };
    expect(previewGate(preview, "LEASE1", 100)).toEqual({ armed: true });
  });

  it("does not authorise a different lease", () => {
    const preview = { asked: asked("LEASE1", 100), result: { lease: "LEASE1", deduction: 100 } };
    expect(previewGate(preview, "LEASE2", 100)).toEqual({ armed: false, reason: "stale" });
  });

  it("does not authorise an amount that differs by a single base unit", () => {
    const preview = { asked: asked("LEASE1", 100), result: { lease: "LEASE1", deduction: 100 } };
    expect(previewGate(preview, "LEASE1", 101)).toEqual({ armed: false, reason: "stale" });
    expect(previewGate(preview, "LEASE1", 99)).toEqual({ armed: false, reason: "stale" });
  });

  it("a dry run cannot authorise a question it did not answer: no preview authorises anything", () => {
    expect(previewGate(null, "LEASE1", 100)).toEqual({ armed: false, reason: "none" });
    expect(previewGate(undefined, "LEASE1", 100)).toEqual({ armed: false, reason: "none" });
  });

  it("asked does not collide across amounts that a naive concatenation would (no accidental prefix collision)", () => {
    expect(asked("L", 1)).not.toBe(asked("L", 10));
    expect(asked("L1", 10)).not.toBe(asked("L", 110));
  });
});

describe("verdictProblem", () => {
  const base = { deductionBase: 0, deposit: 100, status: "mediation", appraiser: "APPRAISER" };

  it("is null when everything is right", () => {
    expect(verdictProblem(base)).toBeNull();
  });

  it("a deduction equal to the whole deposit is allowed (the program's own upper bound)", () => {
    expect(verdictProblem({ ...base, deductionBase: 100 })).toBeNull();
  });

  it("a deduction of exactly 0 is allowed (the program's own lower bound)", () => {
    expect(verdictProblem({ ...base, deductionBase: 0 })).toBeNull();
  });

  it("names 'already closed' for a closed lease", () => {
    expect(verdictProblem({ ...base, status: "closed" })).toMatch(/already closed/);
  });

  it("names the status in quotes for any other non-mediation status", () => {
    expect(verdictProblem({ ...base, status: "active" })).toMatch(/in "active"/);
  });

  it("refuses a lease with no appraiser bound", () => {
    expect(verdictProblem({ ...base, appraiser: "" })).toMatch(/[Nn]o appraiser is bound/);
  });

  it("refuses a deduction that exceeds the deposit", () => {
    expect(verdictProblem({ ...base, deductionBase: 101 })).toMatch(/cannot exceed the deposit/);
  });
});

describe("consoleErrorMessage", () => {
  it("401 and 403 both map to the token-refused message", () => {
    expect(consoleErrorMessage(401, {})).toMatch(/token was refused/);
    expect(consoleErrorMessage(403, {})).toMatch(/token was refused/);
  });

  it("a 401 whose body says 'not configured' maps to the console-is-off message instead", () => {
    expect(consoleErrorMessage(401, { error: "VERDICT_CONSOLE_TOKEN not configured" })).toMatch(/switched off/);
  });

  it("a 403 whose body says 'not configured' is also the console-is-off message", () => {
    expect(consoleErrorMessage(403, { error: "not configured on this deployment" })).toMatch(/switched off/);
  });

  it("maps each backend code to its own message", () => {
    expect(consoleErrorMessage(400, { code: "lease-not-allowed" })).toMatch(/VERDICT_CONSOLE_LEASES/);
    expect(consoleErrorMessage(400, { code: "malformed-body", error: "bad json" })).toBe("bad json");
    expect(consoleErrorMessage(400, { code: "malformed-body" })).toMatch(/could not read the request/);
    expect(consoleErrorMessage(503, { code: "unavailable", error: "rpc down" })).toBe("rpc down");
    expect(consoleErrorMessage(503, { code: "unavailable" })).toMatch(/cannot reach the network/);
    expect(consoleErrorMessage(500, { code: "lease-layout" })).toMatch(/lease layout/);
  });

  it("429 gets its own rate-limit message regardless of body", () => {
    expect(consoleErrorMessage(429, {})).toMatch(/Too many requests/);
  });

  it("an unknown code falls back to the body's error string", () => {
    expect(consoleErrorMessage(500, { code: "something-new", error: "boom" })).toBe("boom");
  });

  it("an empty body falls back to a message naming the status", () => {
    expect(consoleErrorMessage(500, {})).toMatch(/500/);
  });

  it("survives a non-object-but-indexable body (string, number, array) without throwing", () => {
    // NOT covered here: `null` and `undefined` DO throw ("Cannot read properties of null/undefined
    // (reading 'error')"), because the function reads `body.error` / `body.code` with no guard for
    // those two. `postVerdict` can hand this a literal JSON `null` (a valid `res.json()` result, not
    // a parse failure, so the `.catch(() => ({}))` there never runs). Reported to the app agent
    // rather than fixed; see the handoff report.
    expect(() => consoleErrorMessage(500, "oops" as never)).not.toThrow();
    expect(() => consoleErrorMessage(500, 42 as never)).not.toThrow();
    expect(() => consoleErrorMessage(500, [] as never)).not.toThrow();
  });

  it("survives error/code fields that are not strings without throwing", () => {
    expect(() => consoleErrorMessage(500, { error: 42, code: 7 } as never)).not.toThrow();
    expect(consoleErrorMessage(500, { error: 42, code: 7 } as never)).toMatch(/500/);
  });
});

describe("verdictView", () => {
  it("parses digit strings into numbers", () => {
    const v = verdictView({ deduction: "123456", deposit: "1000000", toTenant: "500000", toLandlord: "400000", feePaid: "100000" });
    expect(v.deduction).toBe(123_456);
    expect(v.deposit).toBe(1_000_000);
    expect(v.toTenant).toBe(500_000);
    expect(v.toLandlord).toBe(400_000);
    expect(v.feePaid).toBe(100_000);
  });

  it("a missing numeric field becomes 0, not NaN", () => {
    const v = verdictView({});
    expect(v.deduction).toBe(0);
    expect(Number.isNaN(v.deduction)).toBe(false);
  });

  it("a non-numeric field becomes 0, not NaN", () => {
    const v = verdictView({ deduction: "not a number" });
    expect(v.deduction).toBe(0);
    expect(Number.isNaN(v.deduction)).toBe(false);
  });

  it("signatures filters out non-strings and defaults to []", () => {
    expect(verdictView({ signatures: ["SIG1", 42, null, "SIG2"] }).signatures).toEqual(["SIG1", "SIG2"]);
    expect(verdictView({}).signatures).toEqual([]);
    expect(verdictView({ signatures: "not an array" }).signatures).toEqual([]);
  });

  it("dryRun and appraiserAtaExists are strict === true, so the string 'true' is false", () => {
    expect(verdictView({ dryRun: "true" }).dryRun).toBe(false);
    expect(verdictView({ dryRun: true }).dryRun).toBe(true);
    expect(verdictView({ appraiserAtaExists: "true" }).appraiserAtaExists).toBe(false);
    expect(verdictView({ appraiserAtaExists: true }).appraiserAtaExists).toBe(true);
  });

  it("survives a null/undefined body without throwing", () => {
    expect(() => verdictView(null)).not.toThrow();
    expect(() => verdictView(undefined)).not.toThrow();
  });
});

// verdict.ts reads VITE_API through sponsor.ts at module load, so postVerdict cases set env and
// re-import, as sponsor.test.ts / fiat.test.ts / appraisers.test.ts do.
async function load(env: { api?: string } = {}) {
  vi.resetModules();
  vi.stubEnv("VITE_API", env.api ?? "");
  return import("../verdict");
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("postVerdict", () => {
  it("rejects without VITE_API, naming what to set, and never calls fetch", async () => {
    const v = await load();
    await expect(v.postVerdict("TOKEN", { lease: "L", deduction: 0, dryRun: true })).rejects.toThrow(/VITE_API/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("rejects an empty or whitespace token, and never calls fetch", async () => {
    const v = await load({ api: "http://b" });
    await expect(v.postVerdict("", { lease: "L", deduction: 0, dryRun: true })).rejects.toThrow(/Paste the console token/);
    await expect(v.postVerdict("   ", { lease: "L", deduction: 0, dryRun: true })).rejects.toThrow(/Paste the console token/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("sends exactly {lease, deduction, dryRun} with deduction as a digit string, no other keys", async () => {
    fetchMock().mockResolvedValue(json({ dryRun: true }));
    const v = await load({ api: "http://b" });
    await v.postVerdict("TOKEN", { lease: "LEASE1", deduction: 12_500_000, dryRun: true });
    const [, init] = fetchMock().mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({ lease: "LEASE1", deduction: "12500000", dryRun: true });
    expect(typeof body.deduction).toBe("string");
    expect(typeof body.dryRun).toBe("boolean");
  });

  it("sends the authorization header as Bearer <trimmed token>", async () => {
    fetchMock().mockResolvedValue(json({}));
    const v = await load({ api: "http://b" });
    await v.postVerdict("  TOKEN  ", { lease: "L", deduction: 0, dryRun: true });
    const [, init] = fetchMock().mock.calls[0];
    expect(init.headers.authorization).toBe("Bearer TOKEN");
  });

  it("posts to API + VERDICT_PATH", async () => {
    fetchMock().mockResolvedValue(json({}));
    const v = await load({ api: "http://b" });
    await v.postVerdict("TOKEN", { lease: "L", deduction: 0, dryRun: true });
    expect(fetchMock().mock.calls[0][0]).toBe(`http://b${v.VERDICT_PATH}`);
  });

  it("rejects a non-ok response with consoleErrorMessage's text", async () => {
    fetchMock().mockResolvedValue(json({ code: "lease-not-allowed" }, 400));
    const v = await load({ api: "http://b" });
    await expect(v.postVerdict("TOKEN", { lease: "L", deduction: 0, dryRun: true })).rejects.toThrow(/VERDICT_CONSOLE_LEASES/);
  });

  it("parses a 200 response with verdictView", async () => {
    fetchMock().mockResolvedValue(json({ dryRun: true, deduction: "500000", signatures: [] }));
    const v = await load({ api: "http://b" });
    const result = await v.postVerdict("TOKEN", { lease: "L", deduction: 500_000, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.deduction).toBe(500_000);
    expect(result.signatures).toEqual([]);
  });
});
