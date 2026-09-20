// Demo network + the hardcoded listings (no on-chain listing account yet).
export const RPC: string =
  import.meta.env.VITE_RPC ?? `http://${location.hostname}:8899`;

// Local Surfpool can jump the clock, so the demo can show a realistic 30-day rent period.
// On devnet the clock is real, so periods are compressed (say so out loud).
export const IS_LOCAL = !/devnet|mainnet|testnet/.test(RPC);
export const CAN_FAST_FORWARD = IS_LOCAL;
export const PERIOD_SECS = IS_LOCAL ? 30 * 86_400 : 45;
export const GRACE_SECS = IS_LOCAL ? 3 * 86_400 : 20;
export const TERM_PERIODS = 3;
export const CLAIM_WINDOW_SECS = 10; // CLAIM_WINDOW_SECS of the `demo` program build
export const USDC = 1_000_000;

// must equal ALLOWED_MINT in programs/relstate/src/constants.rs
export const MINT = "CpzHPiiCaJ6LUTcSXgcptmjr8fyto3GAxH48b1FJbYDQ";

export interface ListingData {
  id: string;
  title: string;
  city: string;
  blurb: string;
  rent: number;
  deposit: number;
  /** landlord wallet; null = the demo landlord, the only one this demo can sign for */
  landlord: string | null;
  photo?: string; // optional: drop a photo in app/public and reference it here
}

export const LISTINGS: ListingData[] = [
  { id: "kazimierz", title: "Sunlit 1-bedroom, Kazimierz", city: "Kraków, Poland", blurb: "Furnished · 42 m² · fibre internet · desk by the window", rent: 850 * USDC, deposit: 850 * USDC, landlord: null },
  { id: "planty", title: "Studio by the Planty", city: "Kraków, Poland", blurb: "Unfurnished · 28 m² · quiet courtyard · bikes welcome", rent: 620 * USDC, deposit: 620 * USDC, landlord: null },
  { id: "praga", title: "Brick loft with a view, Praga", city: "Warsaw, Poland", blurb: "Furnished · 65 m² · 2 rooms · balcony", rent: 1200 * USDC, deposit: 1200 * USDC, landlord: "2S2KtCmgK1ga3gdEVLgcGN3mLqhuYYE5uQC5ujY2j3Dn" },
  { id: "zablocie", title: "Garden flat, Zabłocie", city: "Kraków, Poland", blurb: "Furnished · 55 m² · pets allowed · private garden", rent: 990 * USDC, deposit: 990 * USDC, landlord: "7TUgTsmZWnoe6yN9KJggkAybFQ9PwKnmdUUwwJkfFWAR" },
];
