import { afterEach, describe, expect, it, vi } from "vitest";
import { checklist, onboarded, openSteps, rememberOnboarded, wasOnboarded } from "../checklist";
import type { OnboardingState } from "../checklist";

const blank: OnboardingState = { signedIn: false, balance: null, applied: false, rentPaid: false };
const states = (s: OnboardingState) => Object.fromEntries(checklist(s).map((x) => [x.id, x.state]));

afterEach(() => vi.unstubAllGlobals());

describe("checklist", () => {
  it("returns the five steps in order", () => {
    expect(checklist(blank).map((s) => s.id)).toEqual(["account", "identity", "topup", "apply", "rent"]);
  });

  it("a blank state has four todo steps and identity as soon", () => {
    expect(states(blank)).toEqual({ account: "todo", identity: "soon", topup: "todo", apply: "todo", rent: "todo" });
  });

  it("identity defaults to soon and is never todo by default", () => {
    for (const s of [blank, { signedIn: true, balance: 5, applied: true, rentPaid: true }])
      expect(checklist(s).find((x) => x.id === "identity")!.state).toBe("soon");
  });

  it("no token account and a zero balance both leave topup todo; a positive balance is done", () => {
    expect(states({ ...blank, balance: null }).topup).toBe("todo");
    expect(states({ ...blank, balance: 0 }).topup).toBe("todo");
    expect(states({ ...blank, balance: 1 }).topup).toBe("done");
  });

  it("each flag flips exactly its own step", () => {
    expect(states({ ...blank, signedIn: true })).toEqual({ ...states(blank), account: "done" });
    expect(states({ ...blank, balance: 10 })).toEqual({ ...states(blank), topup: "done" });
    expect(states({ ...blank, applied: true })).toEqual({ ...states(blank), apply: "done" });
    expect(states({ ...blank, rentPaid: true })).toEqual({ ...states(blank), rent: "done" });
  });

  it("identity: done marks the step done and changes its detail", () => {
    const soon = checklist(blank).find((x) => x.id === "identity")!;
    const done = checklist({ ...blank, identity: "done" }).find((x) => x.id === "identity")!;
    expect(done.state).toBe("done");
    expect(done.detail).not.toBe(soon.detail);
  });
});

describe("openSteps / onboarded", () => {
  it("openSteps counts only todo steps, never soon", () => {
    expect(openSteps(checklist(blank)).map((s) => s.id)).toEqual(["account", "topup", "apply", "rent"]);
  });

  it("a fully done state is onboarded even while identity is still soon", () => {
    const steps = checklist({ signedIn: true, balance: 100, applied: true, rentPaid: true });
    expect(steps.find((s) => s.id === "identity")!.state).toBe("soon");
    expect(openSteps(steps)).toEqual([]);
    expect(onboarded(steps)).toBe(true);
  });

  it("one remaining todo step means not onboarded", () => {
    expect(onboarded(checklist({ signedIn: true, balance: 100, applied: true, rentPaid: false }))).toBe(false);
    expect(onboarded(checklist(blank))).toBe(false);
  });
});

describe("wasOnboarded / rememberOnboarded", () => {
  it("without localStorage, wasOnboarded is false and neither call throws", () => {
    expect(wasOnboarded("someaddress")).toBe(false);
    expect(() => rememberOnboarded("someaddress")).not.toThrow();
  });

  it("round-trips per wallet through a stored value", () => {
    const m = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) });
    expect(wasOnboarded("a")).toBe(false);
    rememberOnboarded("a");
    expect(wasOnboarded("a")).toBe(true);
    expect(wasOnboarded("b")).toBe(false);
  });

  it("a storage that throws is treated as not onboarded", () => {
    const boom = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom });
    expect(wasOnboarded("a")).toBe(false);
    expect(() => rememberOnboarded("a")).not.toThrow();
  });
});

describe("identity: todo", () => {
  const detailOf = (identity?: "todo" | "done" | "soon") => checklist({ ...blank, identity }).find((x) => x.id === "identity")!.detail;

  it("has its own detail text, neither the soon one nor the done one", () => {
    expect(detailOf("todo")).not.toBe(detailOf(undefined));
    expect(detailOf("todo")).not.toBe(detailOf("done"));
    expect(detailOf("soon")).toBe(detailOf(undefined));
  });

  it("counts as an open step, so the tenant is not onboarded until it is done", () => {
    const steps = checklist({ signedIn: true, balance: 100, applied: true, rentPaid: true, identity: "todo" });
    expect(steps.find((s) => s.id === "identity")!.state).toBe("todo");
    expect(openSteps(steps).map((s) => s.id)).toEqual(["identity"]);
    expect(onboarded(steps)).toBe(false);
  });

  it("is onboarded once identity is done, and stays onboarded while it is soon", () => {
    const rest = { signedIn: true, balance: 100, applied: true, rentPaid: true };
    expect(onboarded(checklist({ ...rest, identity: "done" }))).toBe(true);
    expect(onboarded(checklist({ ...rest, identity: "soon" }))).toBe(true);
  });
});
