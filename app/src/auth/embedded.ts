// Workstream B: sign up with an email and get a Solana wallet, silently.
//
// What the rest of the app may use:
//
//   EmbeddedWalletProvider   wraps a subtree; owns the login state machine for one role
//   useEmbeddedWallet()      the current state, or null outside the provider
//   EmailSignIn              the onboarding block, for the sign-up page's wallet step
//   useSponsorSession()      gives the connected wallet a backend session (every wallet kind)
//   EMBEDDED_ENABLED         false in a build with no provider configured, where the app is unchanged
//
// Everything a provider has to implement is in ./backend.ts; ./mock.ts and ./privy.ts are the two
// implementations. The wallet they produce is an ordinary `WalletProvider` (`kind: "embedded"`), so
// `chain.ts` and `confidential.ts` see nothing new.

export { EmbeddedWalletProvider, useEmbeddedWallet, type EmbeddedWalletState } from "./EmbeddedWallet";
export { EmailSignIn } from "./EmailSignIn";
export { useSponsorSession } from "./useSponsorSession";
export { EMBEDDED_APP_ID, EMBEDDED_ENABLED, EMBEDDED_IS_MOCK, EMBEDDED_MODE, embeddedOffReason, type EmbeddedMode } from "./mode";
export { activeBackend, registerPrivySdk } from "./backends";
export { looksLikeEmail, normalizeEmail, type EmbeddedBackend, type EmbeddedStatus } from "./backend";
export { mockAddressFor, mockKeypair, mockWalletFor } from "./mock";
export { privyBackend, type PrivySdk } from "./privy";
export { clearSession, obtainSession, registerSigner, heldToken, type BackendSession } from "./session";
