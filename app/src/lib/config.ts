// Demo network + the hardcoded listing. Edit LISTING once the real unit is known.
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

export const LISTING = {
  title: "Sunlit 1-bedroom, Kazimierz",
  city: "Kraków, Poland",
  blurb: "Furnished · 42 m² · fibre internet · desk by the window",
  rent: 850 * USDC,
  deposit: 850 * USDC,
  photo: "/unit.jpg", // optional: drop a photo at app/public/unit.jpg
};
