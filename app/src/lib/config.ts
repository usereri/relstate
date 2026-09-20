// Network + lease timing. Point the app at devnet with VITE_RPC in app/.env.local, for example
//   VITE_RPC=https://api.devnet.solana.com
export const RPC: string =
  import.meta.env.VITE_RPC ?? `http://${location.hostname}:8899`;

// Local Surfpool can jump the clock, so a local run can show a realistic 30-day rent period.
// On devnet the clock is real, so periods are compressed (say so out loud).
export const IS_LOCAL = !/devnet|mainnet|testnet/.test(RPC);
export const CAN_FAST_FORWARD = IS_LOCAL;
export const PERIOD_SECS = IS_LOCAL ? 30 * 86_400 : 45;
export const GRACE_SECS = IS_LOCAL ? 3 * 86_400 : 20;
export const TERM_PERIODS = 3;
export const CLAIM_WINDOW_SECS = 10;
export const USDC = 1_000_000;
export const MINT = "CpzHPiiCaJ6LUTcSXgcptmjr8fyto3GAxH48b1FJbYDQ";
export const MAX_TEXT = { title: 60, city: 40, blurb: 120, photo: 120 };
