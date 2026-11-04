// Import this first in every offline test. `src/env.ts` loads `<repo>/.env` as a
// side effect of being imported, so a developer machine with real keys would
// otherwise change what these tests see. Loaded env files never overwrite a
// variable that already exists, so setting the secrets to "" up front pins the
// no-secrets defaults (the loader and `env.ts` both treat "" as unset).
for (const key of [
  "BACKEND_MODE",
  "AUTH_MODE",
  "SESSION_SECRET",
  "ADMIN_TOKEN",
  "FEE_PAYER_KEYPAIR",
  "ATTESTATION_ISSUER_KEYPAIR",
  "TREASURY_KEYPAIR",
  "RUSDC_MINT",
  "RUSDC_AUDITOR_IKM",
  "RUSDC_AUDITOR_ELGAMAL_PUBKEY",
  "USDC_RESERVE_MINT",
  "USDC_RESERVE_TOKEN_ACCOUNT",
  "HELIUS_API_KEY",
  "RPC_URL",
  // So a developer with a real DATABASE_PATH does not have these tests writing to it, and every
  // service built here gets its own in-memory store (store.ts).
  "DATABASE_PATH",
  // Decides whether live mode accepts KYC_PROVIDER=mock; a developer's devnet .env sets it, which
  // silently turned the "live refuses mock KYC" assertions into passes for the wrong config.
  "ALLOW_MOCK_KYC",
  // Not secrets, but they decide which e-mail sender the invites service resolves to, and /health
  // now reports it: a developer's own .env must not change what these tests see.
  "INVITE_EMAIL_SENDER",
  "INVITE_EMAIL_FROM",
  "RESEND_API_KEY",
]) {
  process.env[key] = "";
}
export {};
