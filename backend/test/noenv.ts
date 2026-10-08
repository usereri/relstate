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
]) {
  process.env[key] = "";
}
export {};
