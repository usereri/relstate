// Which embedded-wallet provider this build talks to, resolved from env once.
//
// The point of the email sign-up is that a tenant gets a Solana wallet without knowing they have
// one: no extension, no seed phrase, no SOL. Two providers can do that behind the same interface
// (see ./backend.ts):
//
//   mock   an email-derived keypair this page holds. Needs NO secrets and no provider account,
//          so it is what the demo and `npm run app:*` run on. Labelled "demo wallet" everywhere.
//   privy  a real hosted embedded wallet. Needs a Privy app id, and an SDK binding that is not
//          installed in this repo yet (./privy.ts says exactly what to add).
//
// Deliberately NOT defaulted on: with neither variable set the app behaves exactly as it did
// before this workstream, so the extension and built-in test wallet flows are untouched.

export type EmbeddedMode = "off" | "mock" | "privy";

/** The Privy app id, when one is configured. */
export const EMBEDDED_APP_ID: string = import.meta.env.VITE_EMBEDDED_WALLET_APP_ID ?? "";

const requested = (import.meta.env.VITE_EMBEDDED_WALLET ?? "").trim().toLowerCase();

/**
 * `VITE_EMBEDDED_WALLET` picks the provider outright; with it unset, an app id turns Privy on and
 * nothing turns the whole feature off. A Privy build with no app id cannot work, so it resolves to
 * `off` rather than mounting a provider that would fail on the first click — {@link embeddedOffReason}
 * explains which of the two it was.
 */
export const EMBEDDED_MODE: EmbeddedMode = ((): EmbeddedMode => {
  const picked: EmbeddedMode = requested === "mock" || requested === "privy" ? requested : requested === "off" ? "off" : EMBEDDED_APP_ID ? "privy" : "off";
  return picked === "privy" && EMBEDDED_APP_ID === "" ? "off" : picked;
})();

export const EMBEDDED_ENABLED = EMBEDDED_MODE !== "off";

/** Why the email option is not offered, for a developer reading the console or the sign-up page. */
export function embeddedOffReason(): string | null {
  if (EMBEDDED_ENABLED) return null;
  if (requested === "privy")
    return "VITE_EMBEDDED_WALLET=privy needs VITE_EMBEDDED_WALLET_APP_ID as well. Set it, or use VITE_EMBEDDED_WALLET=mock for a no-secrets demo wallet.";
  if (requested === "off") return "Email sign-up is switched off by VITE_EMBEDDED_WALLET=off.";
  return "Email sign-up is not configured. Set VITE_EMBEDDED_WALLET=mock for a no-secrets demo wallet, or VITE_EMBEDDED_WALLET_APP_ID for Privy.";
}

/** True when the wallet behind the email is a local stand-in, which the UI must say out loud. */
export const EMBEDDED_IS_MOCK = EMBEDDED_MODE === "mock";
