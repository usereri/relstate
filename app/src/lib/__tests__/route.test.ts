import { describe, expect, it } from "vitest";
import { hashQuery, inviteToken, parseRoute, withHashQuery } from "../route";

describe("parseRoute", () => {
  it("routes the known paths", () => {
    expect(parseRoute("#/invite/abc")).toBe("invite");
    expect(parseRoute("#/invite")).toBe("invite");
    expect(parseRoute("#/app")).toBe("app");
    expect(parseRoute("#/signup")).toBe("signup");
    expect(parseRoute("#/signin")).toBe("signin");
    expect(parseRoute("#/")).toBe("home");
    expect(parseRoute("#")).toBe("home");
  });

  it("strips a query string or in-page fragment after the route", () => {
    expect(parseRoute("#/invite/abc?x=1")).toBe("invite");
    expect(parseRoute("#/invite/abc#frag")).toBe("invite");
  });

  it("anything unknown falls back to home", () => {
    expect(parseRoute("#/nope")).toBe("home");
    expect(parseRoute("")).toBe("home");
  });

  it("the retired '#/appraiser' console route is gone", () => {
    expect(parseRoute("#/appraiser")).toBe("home");
  });

  it("a path that merely starts with a known route but is not exactly it falls back to home", () => {
    expect(parseRoute("#/invited")).toBe("home");
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
    expect(withHashQuery("#/app?x=1", (q) => q.set("y", "2"))).toBe("#/app?x=1&y=2");
    expect(withHashQuery("#/app?x=1", (q) => q.delete("x"))).toBe("#/app");
    expect(withHashQuery("#/signin", (q) => q.set("return", "app"))).toBe("#/signin?return=app");
  });
});

describe("inviteToken", () => {
  it("reads the token from the path the backend's e-mail link uses", () => {
    expect(inviteToken("#/invite/abc123")).toBe("abc123");
    expect(inviteToken("#/invite/abc123?x=1")).toBe("abc123");
    expect(inviteToken("#/invite/a%2Fb")).toBe("a/b");
  });
  it("is empty without a token, on another route, or for a half-escaped one", () => {
    expect(inviteToken("#/invite")).toBe("");
    expect(inviteToken("#/app?tab=lease")).toBe("");
    expect(inviteToken("#/invite/%E0%A4%A")).toBe("");
  });
});
