import { describe, expect, it } from "vitest";
import { EVENTS, EVENTS_NOTE, EVENT_CITIES, dateLabel, toFilter, upcoming } from "../events";
import type { EventEntry } from "../events";
import { MAX_LABEL_CHARS, MAX_RADIUS_KM, MIN_RADIUS_KM } from "../params";
import { GEO_FILE } from "./fixtures";

const ev = (over: Partial<EventEntry>): EventEntry => ({
  id: "x",
  kind: "event",
  name: "N",
  venue: "V",
  city: "Kraków",
  area: "A",
  starts: "2026-10-20",
  lat: 50,
  lng: 19,
  radiusKm: 2,
  blurb: "",
  ...over,
});

describe("EVENTS", () => {
  it("is sorted by start date", () => {
    const starts = EVENTS.map((e) => e.starts);
    expect(starts).toEqual([...starts].sort());
  });

  it("still says it is sample data", () => {
    expect(EVENTS_NOTE).toMatch(/SAMPLE DATA/i);
  });

  it("only names cities the demo listings are in", () => {
    // geo file cities plus the two scripts/setup-demo.ts creates its listings in
    const known = new Set([...GEO_FILE.items.map((i) => i.city), "Kraków", "Warsaw"]);
    for (const e of EVENTS) expect(known.has(e.city), e.id).toBe(true);
    expect(EVENT_CITIES.every((c) => known.has(c))).toBe(true);
  });

  it("has valid coordinates, radii and unique ids", () => {
    for (const e of EVENTS) {
      expect(Math.abs(e.lat), e.id).toBeLessThanOrEqual(90);
      expect(Math.abs(e.lng), e.id).toBeLessThanOrEqual(180);
      expect(e.radiusKm, e.id).toBeGreaterThanOrEqual(MIN_RADIUS_KM);
      expect(e.radiusKm, e.id).toBeLessThanOrEqual(MAX_RADIUS_KM);
    }
    expect(new Set(EVENTS.map((e) => e.id)).size).toBe(EVENTS.length);
  });
});

describe("upcoming", () => {
  const today = new Date("2026-10-10T12:00:00Z");

  it("returns only events that have not finished, soonest first", () => {
    const out = upcoming(EVENTS, today);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((e) => (e.ends ?? e.starts) >= "2026-10-10")).toBe(true);
    expect(out[0].starts).toBe("2026-10-20");
  });

  it("keeps a multi-day event that started before today but has not ended", () => {
    const running = ev({ id: "run", starts: "2026-10-08", ends: "2026-10-12" });
    expect(upcoming([running], today).map((e) => e.id)).toEqual(["run"]);
  });

  it("counts an event happening today as upcoming", () => {
    expect(upcoming([ev({ starts: "2026-10-10" }), ev({ id: "old", starts: "2026-10-09" })], today)).toHaveLength(1);
  });

  it("falls back to the full list when everything is in the past", () => {
    expect(upcoming(EVENTS, new Date("2099-01-01T00:00:00Z"), 100)).toEqual(EVENTS);
  });

  it("respects the limit", () => {
    expect(upcoming(EVENTS, today, 2)).toHaveLength(2);
    expect(upcoming(EVENTS, new Date("2099-01-01T00:00:00Z"), 3)).toHaveLength(3);
  });
});

describe("toFilter", () => {
  it("turns an event into a filter anchored on the venue", () => {
    expect(toFilter(ev({ venue: "Błonia meadow", lat: 50.058, lng: 19.9, radiusKm: 2 }))).toEqual({
      city: "Kraków",
      point: { lat: 50.058, lng: 19.9 },
      radiusKm: 2,
      label: "Błonia meadow",
    });
  });

  it("clamps a silly radius", () => {
    expect(toFilter(ev({ radiusKm: 1e6 })).radiusKm).toBe(MAX_RADIUS_KM);
    expect(toFilter(ev({ radiusKm: 0 })).radiusKm).toBe(MIN_RADIUS_KM);
    expect(toFilter(ev({ radiusKm: NaN })).radiusKm).toBe(3);
  });

  it("sanitises the label", () => {
    const f = toFilter(ev({ venue: `<script>alert("x")</script>${"a".repeat(200)}` }));
    expect(f.label).not.toMatch(/[<>"]/);
    expect(f.label!.length).toBeLessThanOrEqual(MAX_LABEL_CHARS);
  });

  it("omits the label when nothing printable is left", () => {
    expect(toFilter(ev({ venue: "<>" })).label).toBeUndefined();
  });
});

describe("dateLabel", () => {
  it("formats a single day", () => {
    expect(dateLabel(ev({ starts: "2026-10-01" }))).toBe("1 Oct 2026");
  });

  it("formats a same-month range with one month name", () => {
    expect(dateLabel(ev({ starts: "2026-10-20", ends: "2026-10-23" }))).toBe("20–23 Oct 2026");
  });

  it("spells out both ends of a range across months", () => {
    expect(dateLabel(ev({ starts: "2026-10-28", ends: "2026-11-02" }))).toBe("28 Oct 2026 – 2 Nov 2026");
  });

  it("does not shift the day with the local time zone", () => {
    expect(dateLabel(ev({ starts: "2026-01-01" }))).toBe("1 Jan 2026");
  });
});
