import { describe, expect, it } from "vitest";
import { parseRoute } from "../Brand";

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
