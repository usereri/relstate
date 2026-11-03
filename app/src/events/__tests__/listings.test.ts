import { describe, expect, it } from "vitest";
import { geoIndex, locate, nearby, placeAll } from "../listings";
import type { ListingLike } from "../listings";
import { AGH, GEO_FILE, SEEDED } from "./fixtures";

const row = (over: Record<string, unknown>) => ({ title: "T", city: "Kraków", lat: 50, lng: 19, ...over });

describe("geoIndex", () => {
  it("builds from the real geo file and places every seeded listing", () => {
    const index = geoIndex(GEO_FILE);
    for (const l of SEEDED) expect(locate(l, index), l.title).not.toBeNull();
  });

  it("skips rows with a bad or missing position without throwing", () => {
    const index = geoIndex({
      items: [
        row({ title: "ok" }),
        row({ title: "no-lat", lat: undefined }),
        row({ title: "string-lat", lat: "50" }),
        row({ title: "nan", lng: NaN }),
        row({ title: "lat-range", lat: 91 }),
        row({ title: "lng-range", lng: -181 }),
        null,
        "x",
      ],
    });
    expect(index.size).toBe(1);
    expect(locate({ id: "9", title: "ok", city: "Kraków" }, index)).not.toBeNull();
  });

  it("skips rows with no city", () => {
    expect(geoIndex({ items: [row({ city: undefined }), row({ city: "  " })] }).size).toBe(0);
  });

  it.each([null, undefined, 42, "x", [], {}, { items: "x" }, { items: null }])("tolerates %j as the whole file", (raw) =>
    expect(geoIndex(raw).size).toBe(0),
  );
});

describe("locate", () => {
  const index = geoIndex(GEO_FILE);

  it("matches on title and city regardless of case and diacritics", () => {
    const at = locate({ id: "99", title: "GARDEN FLAT, ZABLOCIE", city: "krakow" }, index);
    expect(at?.area).toBe("Zabłocie");
  });

  it("falls back to listingId plus city when the title differs", () => {
    const at = locate({ id: "2", title: "Renamed on chain", city: "Kraków" }, index);
    expect(at?.area).toBe("Planty / Old Town");
  });

  it("does not match a listing id from another city", () => {
    expect(locate({ id: "3", title: "Renamed", city: "Kraków" }, index)).toBeNull();
  });

  it("returns null for an unknown listing", () => {
    expect(locate({ id: "77", title: "Nowhere", city: "Gdańsk" }, index)).toBeNull();
  });
});

describe("nearby", () => {
  const index = geoIndex(GEO_FILE);
  const titles = (r: { rows: { listing: ListingLike }[] }) => r.rows.map((x) => x.listing.title);

  it("keeps listings within the radius, nearest first (AGH, 3 km)", () => {
    const r = nearby(SEEDED, index, { city: "Kraków", point: AGH, radiusKm: 3, label: "AGH" });
    expect(titles(r)).toEqual(["Studio by the Planty", "Sunlit 1-bedroom, Kazimierz"]);
    expect(r.rows[0].km).toBeCloseTo(1.05, 1);
    expect(r.rows[1].km).toBeCloseTo(2.16, 1);
    expect(r.rows[0].area).toBe("Planty / Old Town");
  });

  it("counts what it removed as hidden", () => {
    const r = nearby(SEEDED, index, { city: "Kraków", point: AGH, radiusKm: 3 });
    expect(r.hidden).toBe(2); // Praga (other city) and Zabłocie (about 3.4 km)
    expect(r.unplaced).toBe(0);
  });

  it("includes Zabłocie once the radius reaches it", () => {
    const r = nearby(SEEDED, index, { city: "Kraków", point: AGH, radiusKm: 4 });
    expect(titles(r)).toEqual(["Studio by the Planty", "Sunlit 1-bedroom, Kazimierz", "Garden flat, Zabłocie"]);
  });

  it("keeps everything in the city with a huge radius", () => {
    const r = nearby(SEEDED, index, { city: "Kraków", point: AGH, radiusKm: 50 });
    expect(r.rows).toHaveLength(3);
    expect(r.hidden).toBe(1);
  });

  it("without a city, a huge radius still excludes a listing 250 km away only by distance", () => {
    expect(nearby(SEEDED, index, { point: AGH, radiusKm: 50 }).rows).toHaveLength(3);
  });

  it("counts listings missing from the geo file as unplaced and excludes them", () => {
    const extra: ListingLike[] = [...SEEDED, { id: "50", title: "Not in the file", city: "Kraków" }];
    const r = nearby(extra, index, { city: "Kraków", point: AGH, radiusKm: 50 });
    expect(titles(r)).not.toContain("Not in the file");
    expect(r.unplaced).toBe(1);
    expect(r.hidden).toBe(2); // Praga plus the unplaced one
  });

  it("does not count other cities' listings as unplaced", () => {
    const extra: ListingLike[] = [{ id: "51", title: "Mystery", city: "Warsaw" }];
    expect(nearby(extra, index, { city: "Kraków", point: AGH, radiusKm: 3 }).unplaced).toBe(0);
  });

  it("with a city only, keeps the city's listings in input order with km null", () => {
    const shuffled = [SEEDED[3], SEEDED[2], SEEDED[0], SEEDED[1]];
    const r = nearby(shuffled, index, { city: "krakow", radiusKm: 3 });
    expect(titles(r)).toEqual(["Garden flat, Zabłocie", "Sunlit 1-bedroom, Kazimierz", "Studio by the Planty"]);
    expect(r.rows.every((x) => x.km === null)).toBe(true);
    expect(r.hidden).toBe(1);
    expect(r.unplaced).toBe(0);
  });

  it("returns nothing, without throwing, for an empty list", () => {
    expect(nearby([], index, { point: AGH, radiusKm: 3 })).toEqual({ rows: [], hidden: 0, unplaced: 0 });
  });
});

describe("placeAll", () => {
  it("preserves input order, annotates the area and leaves km null", () => {
    const index = geoIndex(GEO_FILE);
    const extra: ListingLike = { id: "50", title: "Not in the file", city: "Kraków" };
    const input = [SEEDED[3], extra, SEEDED[0]];
    const rows = placeAll(input, index);
    expect(rows.map((r) => r.listing)).toEqual(input);
    expect(rows.map((r) => r.area)).toEqual(["Zabłocie", undefined, "Kazimierz"]);
    expect(rows.every((r) => r.km === null)).toBe(true);
  });
});
