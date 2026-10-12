import { describe, expect, it } from "vitest";
import { hashQuery, parseRoute, withHashQuery } from "../route";

describe("parseRoute", () => {
  it("routes the known paths", () => {
    expect(parseRoute("#/appraiser")).toBe("appraiser");
    expect(parseRoute("#/app")).toBe("app");
    expect(parseRoute("#/signup")).toBe("signup");
    expect(parseRoute("#/signin")).toBe("signin");
    expect(parseRoute("#/")).toBe("home");
    expect(parseRoute("#")).toBe("home");
  });

  it("strips a query string or in-page fragment after the route", () => {
    expect(parseRoute("#/appraiser?x=1")).toBe("appraiser");
    expect(parseRoute("#/appraiser#frag")).toBe("appraiser");
  });

  it("anything unknown falls back to home", () => {
    expect(parseRoute("#/nope")).toBe("home");
    expect(parseRoute("")).toBe("home");
  });

  it("'#/app' is its own route, not swallowed by a prefix match against 'appraiser'", () => {
    expect(parseRoute("#/app")).toBe("app");
    expect(parseRoute("#/app")).not.toBe("appraiser");
  });

  it("a path that merely starts with a known route but is not exactly it falls back to home", () => {
    expect(parseRoute("#/appraiser-extra")).toBe("home");
    expect(parseRoute("#/apps")).toBe("home");
  });
});

describe("hashQuery", () => {
  it("no query at all: empty params", () => {
    expect(hashQuery("#/app").toString()).toBe("");
  });

  it("a query present: parsed out", () => {
    expect(hashQuery("#/app?tab=wallet&topup=done").get("tab")).toBe("wallet");
    expect(hashQuery("#/app?tab=wallet&topup=done").get("topup")).toBe("done");
  });
});

describe("withHashQuery", () => {
  it("setting a key that already exists overwrites it, route kept", () => {
    expect(withHashQuery("#/app?tab=wallet", (q) => q.set("tab", "profile"))).toBe("#/app?tab=profile");
  });

  it("adding a key to a hash with no query yet", () => {
    expect(withHashQuery("#/app", (q) => q.set("tab", "wallet"))).toBe("#/app?tab=wallet");
  });

  it("deleting the last key makes the '?' disappear", () => {
    expect(withHashQuery("#/app?tab=wallet", (q) => q.delete("tab"))).toBe("#/app");
  });

  it("deleting one of several keys keeps the rest, '?' intact", () => {
    expect(withHashQuery("#/app?tab=wallet&topup=done", (q) => q.delete("topup"))).toBe("#/app?tab=wallet");
  });

  it("an empty hash becomes '#/' rather than ''", () => {
    expect(withHashQuery("", (q) => q.set("tab", "wallet"))).toBe("#/?tab=wallet");
  });

  it("never touches the route segment, whatever the change does to the query", () => {
    expect(withHashQuery("#/appraiser?x=1", (q) => q.set("y", "2"))).toBe("#/appraiser?x=1&y=2");
    expect(withHashQuery("#/appraiser?x=1", (q) => q.delete("x"))).toBe("#/appraiser");
    expect(withHashQuery("#/signin", (q) => q.set("return", "app"))).toBe("#/signin?return=app");
  });
});
