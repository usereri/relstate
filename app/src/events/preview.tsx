/**
 * A developer page, not a screen: `app/events-preview.html` on the dev server.
 *
 * It renders the **real** `Listings` browse view -- the events strip, the banner, the per-listing
 * distances -- against the four listings `scripts/setup-demo.ts` seeds, so the filter can be seen
 * and screenshotted without a validator, a wallet or a funded account. The only things faked are
 * the chain reads: `me` is null, so `Listings` asks the network for nothing, and the handlers are
 * no-ops.
 *
 * Nothing here ships in the app bundle; the entries in `vite.config.ts` are `index.html` and
 * `confidential-check.html`.
 *
 *     npm run app   →   http://localhost:5173/events-preview.html
 *     …?city=Krak%C3%B3w&near=50.0647,19.9229&radius=3&label=AGH+University+of+Krakow
 *
 * The query string is the same hand-off the marketing site emits (`docs/site.md`), so opening it
 * with parameters is also the quickest check that the link contract still holds.
 */
import "@/polyfill"; // Listings reaches chain.ts, which needs the Buffer global. Must be first.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FlaskConical } from "lucide-react";
import type { ListingView } from "@/lib/chain";
import type { Handlers } from "@/screens";
import { Listings } from "@/views";
import "@/index.css";

const USDC = 1_000_000;
const LANDLORD = "Demo1andlord1111111111111111111111111111111";

/** The titles and cities matter: they are the keys into `app/public/listings-geo.json`. */
const LISTINGS: ListingView[] = [
  {
    address: "Prev1111111111111111111111111111111111111111",
    id: "1",
    landlord: LANDLORD,
    rent: 850 * USDC,
    deposit: 850 * USDC,
    region: "PL",
    title: "Sunlit 1-bedroom, Kazimierz",
    city: "Kraków",
    blurb: "Furnished · 42 m² · fibre internet · desk by the window",
    photo: "/listings/kazimierz.jpg",
  },
  {
    address: "Prev2222222222222222222222222222222222222222",
    id: "2",
    landlord: LANDLORD,
    rent: 620 * USDC,
    deposit: 620 * USDC,
    region: "PL",
    title: "Studio by the Planty",
    city: "Kraków",
    blurb: "Unfurnished · 28 m² · quiet courtyard · bikes welcome",
    photo: "/listings/planty.jpg",
  },
  {
    address: "Prev3333333333333333333333333333333333333333",
    id: "3",
    landlord: LANDLORD,
    rent: 1200 * USDC,
    deposit: 1200 * USDC,
    region: "PL",
    title: "Brick loft with a view, Praga",
    city: "Warsaw",
    blurb: "Furnished · 65 m² · 2 rooms · balcony",
    photo: "/listings/praga.jpg",
  },
  {
    address: "Prev4444444444444444444444444444444444444444",
    id: "4",
    landlord: LANDLORD,
    rent: 990 * USDC,
    deposit: 990 * USDC,
    region: "PL",
    title: "Garden flat, Zabłocie",
    city: "Kraków",
    blurb: "Furnished · 55 m² · pets allowed · private garden",
    photo: "/listings/zablocie.jpg",
  },
  // deliberately absent from listings-geo.json: the location-unknown case
  {
    address: "Prev5555555555555555555555555555555555555555",
    id: "5",
    landlord: LANDLORD,
    rent: 700 * USDC,
    deposit: 700 * USDC,
    region: "PL",
    title: "Attic room, address withheld",
    city: "Kraków",
    blurb: "Furnished · 30 m² · no coordinates on file",
    photo: "",
  },
];

const no = async () => false;
const h: Handlers = {
  busy: null,
  createListing: no,
  closeListing: no,
  apply: no,
  closeApplication: no,
  propose: no,
  fund: no,
  pay: no,
  release: no,
  markDefault: no,
  claim: no,
  acceptDeduction: no,
  abandonDispute: no,
  escalateToMediation: no,
  proposeAppraisers: no,
  pickAppraiser: no,
  bindDefaultAppraiser: no,
  expireMediation: no,
  finalizeDeduction: no,
  jump: no,
};

function Preview() {
  return (
    <div className="min-h-dvh" data-role="tenant">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-5 pb-16 pt-8 sm:px-8">
        <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning">
          <FlaskConical className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">
            Developer preview of the Apartments tab. Five invented listings, no chain, no wallet. Add{" "}
            <code className="break-all font-mono">?near=50.0647,19.9229&amp;label=AGH</code> to arrive pre-filtered.
          </span>
        </p>
        <Listings mode="browse" me={null} listings={LISTINGS} h={h} />
      </div>
    </div>
  );
}

document.documentElement.dataset.role = "tenant";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
