import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ListingLike } from "../listings";

/** The real geo file, read from disk (it is a public asset, not an importable module). */
export const GEO_FILE: { items: { listingId: string; title: string; city: string; area: string; lat: number; lng: number }[] } =
  JSON.parse(readFileSync(resolve(__dirname, "../../../public/listings-geo.json"), "utf8"));

/** The four seeded listings exactly as scripts/setup-demo.ts creates them. */
export const SEEDED: ListingLike[] = [
  { id: "1", title: "Sunlit 1-bedroom, Kazimierz", city: "Kraków" },
  { id: "2", title: "Studio by the Planty", city: "Kraków" },
  { id: "3", title: "Brick loft with a view, Praga", city: "Warsaw" },
  { id: "4", title: "Garden flat, Zabłocie", city: "Kraków" },
];

export const AGH = { lat: 50.0647, lng: 19.9229 };
