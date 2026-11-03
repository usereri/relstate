import { describe, expect, it } from "vitest";
import { WALKABLE_KM, distanceLabel, formatKm, haversineKm, walkMinutes } from "../geo";

describe("haversineKm", () => {
  it("is zero for the same point", () => {
    expect(haversineKm({ lat: 50.06, lng: 19.94 }, { lat: 50.06, lng: 19.94 })).toBe(0);
  });

  it("gives one degree of longitude on the equator as about 111.2 km", () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111.195, 1);
  });

  it("puts Krakow and Warsaw about 252 km apart", () => {
    const km = haversineKm({ lat: 50.0647, lng: 19.945 }, { lat: 52.2297, lng: 21.0122 });
    expect(km).toBeGreaterThan(250);
    expect(km).toBeLessThan(255);
  });

  it("is symmetric", () => {
    const a = { lat: 50.0647, lng: 19.9229 };
    const b = { lat: 50.0472, lng: 19.9611 };
    expect(haversineKm(a, b)).toBe(haversineKm(b, a));
  });

  it("returns NaN rather than a plausible number for bad input", () => {
    const ok = { lat: 1, lng: 1 };
    expect(haversineKm({ lat: NaN, lng: 0 }, ok)).toBeNaN();
    expect(haversineKm(ok, { lat: 0, lng: Infinity })).toBeNaN();
    expect(haversineKm({ lat: 0 } as never, ok)).toBeNaN();
    expect(haversineKm(undefined as never, ok)).toBeNaN();
    expect(haversineKm({ lat: "1", lng: 2 } as never, ok)).toBeNaN();
  });

  it("does not produce NaN for antipodal points", () => {
    // floating point can push the haversine term a hair above 1, and asin(>1) is NaN
    const km = haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 });
    expect(km).toBeCloseTo(Math.PI * 6371.0088, 1);
    expect(haversineKm({ lat: 50, lng: 20 }, { lat: -50, lng: -160 })).not.toBeNaN();
  });
});

describe("walkMinutes", () => {
  it("is 12 minutes per kilometre", () => {
    expect(walkMinutes(1)).toBe(12);
    expect(walkMinutes(2.5)).toBe(30);
  });

  it("is never 0", () => {
    expect(walkMinutes(0)).toBe(1);
    expect(walkMinutes(0.001)).toBe(1);
    expect(walkMinutes(-3)).toBe(1);
    expect(walkMinutes(NaN)).toBe(1);
  });
});

describe("formatKm", () => {
  it("uses one decimal under 10 km", () => {
    expect(formatKm(0.44)).toBe("0.4 km");
    expect(formatKm(1.2)).toBe("1.2 km");
    expect(formatKm(3)).toBe("3.0 km");
  });

  it("uses none from 10 km", () => {
    expect(formatKm(10)).toBe("10 km");
    expect(formatKm(12.4)).toBe("12 km");
  });

  it("returns an empty string for junk", () => {
    expect(formatKm(NaN)).toBe("");
    expect(formatKm(-1)).toBe("");
    expect(formatKm(Infinity)).toBe("");
  });
});

describe("distanceLabel", () => {
  it("shows the walk and the venue for a short distance", () => {
    expect(distanceLabel(1.2, "AGH")).toBe("14 min walk · 1.2 km from AGH");
  });

  it("omits the 'from' clause without a label", () => {
    expect(distanceLabel(1.2)).toBe("14 min walk · 1.2 km");
  });

  it("keeps the walk clause at the walkable limit and drops it above", () => {
    expect(distanceLabel(WALKABLE_KM, "X")).toContain("min walk");
    expect(distanceLabel(WALKABLE_KM + 0.5, "X")).toBe("5.5 km from X");
  });

  it("never says 0 min", () => {
    expect(distanceLabel(0)).toBe("1 min walk · 0.0 km");
  });

  it("is empty when the distance is unusable", () => {
    expect(distanceLabel(NaN, "X")).toBe("");
  });
});
