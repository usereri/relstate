import { describe, expect, it } from "vitest";
import {
  DEFAULT_RADIUS_KM,
  MAX_CITY_CHARS,
  MAX_LABEL_CHARS,
  MAX_RADIUS_KM,
  MIN_RADIUS_KM,
  filterTitle,
  fold,
  parseLatLng,
  parseNearParams,
  parseRadiusKm,
  safeCity,
  safeLabel,
  sameName,
} from "../params";

describe("parseLatLng", () => {
  it("reads a valid pair", () => {
    expect(parseLatLng("50.0647,19.9229")).toEqual({ lat: 50.0647, lng: 19.9229 });
  });

  it("accepts negatives, plus signs, spaces and the extreme corners", () => {
    expect(parseLatLng("-33.86,+151.2")).toEqual({ lat: -33.86, lng: 151.2 });
    expect(parseLatLng(" 50 , 19 ")).toEqual({ lat: 50, lng: 19 });
    expect(parseLatLng("90,180")).toEqual({ lat: 90, lng: 180 });
    expect(parseLatLng("-90,-180")).toEqual({ lat: -90, lng: -180 });
  });

  it.each(["", "abc", ",", "50", "50,19,3", "NaN,19", "Infinity,0", "91,0", "-91,0", "0,181", "0,-181", "1e2,0", "0x10,0"])(
    "rejects %j",
    (raw) => expect(parseLatLng(raw)).toBeNull(),
  );

  it("does not let an empty half become 0", () => {
    // Number("") === 0, which would silently put the pin in the Gulf of Guinea
    expect(parseLatLng(",19.9")).toBeNull();
    expect(parseLatLng("50.1,")).toBeNull();
    expect(parseLatLng(" ,19.9")).toBeNull();
  });

  it("rejects null and undefined", () => {
    expect(parseLatLng(null)).toBeNull();
    expect(parseLatLng(undefined)).toBeNull();
  });
});

describe("parseRadiusKm", () => {
  it.each([null, undefined, "", "abc", "0", "-5", "NaN", "Infinity"])("falls back to the default for %j", (raw) =>
    expect(parseRadiusKm(raw as string | null)).toBe(DEFAULT_RADIUS_KM),
  );

  it("clamps a huge radius to the maximum", () => {
    expect(parseRadiusKm("1e9")).toBe(DEFAULT_RADIUS_KM); // exponent form is not a plain number, so it is junk
    expect(parseRadiusKm("99999")).toBe(MAX_RADIUS_KM);
    expect(parseRadiusKm("999999999999999999999999")).toBe(MAX_RADIUS_KM);
  });

  it("clamps a tiny radius to the minimum", () => {
    expect(parseRadiusKm("0.001")).toBe(MIN_RADIUS_KM);
  });

  it("keeps a sane value", () => {
    expect(parseRadiusKm("2")).toBe(2);
    expect(parseRadiusKm("1.5")).toBe(1.5);
  });
});

describe("safeLabel", () => {
  it("strips tags and quotes", () => {
    const out = safeLabel(`<script>alert("1")</script> 'x'`) as string;
    expect(out).not.toMatch(/[<>"]/);
    expect(out).toContain("alert");
  });

  it("returns undefined for a label that is only a tag's worth of punctuation", () => {
    expect(safeLabel("<>\"")).toBeUndefined();
    expect(safeLabel("...---")).toBeUndefined();
  });

  it("caps the length", () => {
    const out = safeLabel("a".repeat(500)) as string;
    expect(out.length).toBe(MAX_LABEL_CHARS);
  });

  it("collapses control characters, newlines and tabs to single spaces", () => {
    expect(safeLabel("AGH\n\t\r\u0000University‮  Krakow")).toBe("AGH University Krakow");
  });

  it("returns undefined for empty, whitespace and nullish input", () => {
    expect(safeLabel("")).toBeUndefined();
    expect(safeLabel("   \n ")).toBeUndefined();
    expect(safeLabel(null)).toBeUndefined();
    expect(safeLabel(undefined)).toBeUndefined();
  });

  it.each(["ICE Kraków Congress Centre", "Błonia meadow", "Łazienki"])("leaves %j intact", (name) =>
    expect(safeLabel(name)).toBe(name),
  );

  it("normalises decomposed diacritics to their composed form", () => {
    expect(safeLabel("Kraków")).toBe("Kraków");
  });
});

describe("safeCity", () => {
  it("keeps a real city and strips markup", () => {
    expect(safeCity("Kraków")).toBe("Kraków");
    // tag-shaped runs go whole: a character-by-character strip would leave "bWarsawb"
    expect(safeCity("<b>Warsaw</b>")).toBe("Warsaw");
  });

  it("caps the length and rejects digit-only or empty input", () => {
    expect((safeCity("a".repeat(500)) as string).length).toBe(MAX_CITY_CHARS);
    expect(safeCity("12345")).toBeUndefined();
    expect(safeCity("")).toBeUndefined();
  });
});

describe("fold", () => {
  it("folds case, diacritics and surrounding space", () => {
    for (const s of ["Kraków", "KRAKÓW", " kraków ", "Krakow", "Kraków"]) expect(fold(s)).toBe("krakow");
  });

  it("flattens letters with no NFD decomposition", () => {
    expect(fold("Zabłocie")).toBe("zablocie");
    expect(fold("ŁÓDŹ")).toBe("lodz");
  });

  it("collapses inner whitespace and tolerates nullish input", () => {
    expect(fold("a \t b")).toBe("a b");
    expect(fold(undefined as never)).toBe("");
  });
});

describe("sameName", () => {
  it("matches the same name written differently", () => {
    expect(sameName("Kraków", "Krakow")).toBe(true);
    expect(sameName("Kraków", "KRAKÓW")).toBe(true);
    expect(sameName("Kraków", " kraków ")).toBe(true);
    expect(sameName("Zabłocie", "Zablocie")).toBe(true);
  });

  it("does not match different names, including endonym and exonym", () => {
    expect(sameName("Warsaw", "Warszawa")).toBe(false);
    expect(sameName("Kraków", "Warsaw")).toBe(false);
  });

  it("never matches empty against empty", () => {
    expect(sameName("", "")).toBe(false);
    expect(sameName(undefined, undefined)).toBe(false);
    expect(sameName("  ", "")).toBe(false);
  });
});

describe("parseNearParams", () => {
  it("returns null when the link carries nothing relevant", () => {
    expect(parseNearParams({})).toBeNull();
    expect(parseNearParams({ search: "", hash: "#/app" })).toBeNull();
    expect(parseNearParams({ search: "?radius=2&label=AGH" })).toBeNull();
  });

  it("returns null for a role param alone", () => {
    expect(parseNearParams({ hash: "#/app?role=tenant" })).toBeNull();
    expect(parseNearParams({ search: "?role=landlord" })).toBeNull();
  });

  it("reads params before the hash", () => {
    expect(parseNearParams({ search: "?city=Krak%C3%B3w&near=50.0647,19.9229&radius=2&label=AGH" })).toEqual({
      city: "Kraków",
      point: { lat: 50.0647, lng: 19.9229 },
      radiusKm: 2,
      label: "AGH",
    });
  });

  it("reads params inside the hash", () => {
    expect(parseNearParams({ hash: "#/app?city=Krak%C3%B3w&near=50.0647,19.9229&radius=2&label=AGH" })).toEqual({
      city: "Kraków",
      point: { lat: 50.0647, lng: 19.9229 },
      radiusKm: 2,
      label: "AGH",
    });
  });

  it("lets the hash win when both carry the same key", () => {
    const f = parseNearParams({ search: "?city=Warsaw&radius=5", hash: "#/app?city=Krak%C3%B3w" });
    expect(f?.city).toBe("Kraków");
    expect(f?.radiusKm).toBe(5); // keys only in the query string still come through
  });

  it("defaults the radius to 3", () => {
    expect(parseNearParams({ search: "?near=50,19" })?.radiusKm).toBe(3);
  });

  it("gives a city-only filter when the pin is invalid", () => {
    const f = parseNearParams({ search: "?city=Warsaw&near=garbage" });
    expect(f).toEqual({ city: "Warsaw", radiusKm: 3 });
    expect(f?.point).toBeUndefined();
  });

  it("gives a point-only filter when the city is invalid", () => {
    const f = parseNearParams({ search: "?city=12345&near=50,19" });
    expect(f).toEqual({ point: { lat: 50, lng: 19 }, radiusKm: 3 });
  });

  it("returns null when both are invalid", () => {
    expect(parseNearParams({ search: "?city=%3C%3E&near=91,0" })).toBeNull();
  });

  it("sanitises a hostile label", () => {
    // nothing is left of a label that was only a tag, so the filter keeps its point and loses its name
    const tag = parseNearParams({ search: `?near=50,19&label=${encodeURIComponent("<img src=x onerror=alert(1)>")}` });
    expect(tag).toEqual({ point: { lat: 50, lng: 19 }, radiusKm: 3 });
    const mixed = parseNearParams({ search: `?near=50,19&label=${encodeURIComponent("AGH <script>alert(1)</script>")}` });
    expect(mixed?.label).not.toMatch(/[<>]/);
    expect(mixed?.label).toMatch(/^AGH/);
  });
});

describe("filterTitle", () => {
  it("prefers the label, then the city, then a generic name", () => {
    expect(filterTitle({ label: "AGH", city: "Kraków", radiusKm: 3 })).toBe("AGH");
    expect(filterTitle({ city: "Kraków", radiusKm: 3 })).toBe("Kraków");
    expect(filterTitle({ point: { lat: 1, lng: 1 }, radiusKm: 3 })).toBe("your pin");
  });
});
