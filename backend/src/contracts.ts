// Contracts 2, 3, 4 and 6: shared types between backend, program and app. Change only by agreement.

/** Regenerated in Phase 1 (the old `5J52oGfo7Bj…` had no keypair). See docs/contracts/program-interface.md. */
export const RELSTATE_PROGRAM = "G4iMjveQKXztnGoxigAeWPrb5evT9yt6qaLkgQEp2dXm";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const ZK_ELGAMAL_PROOF_PROGRAM = "ZkE1Gama1Proof11111111111111111111111111111";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

/** Contract 2: POST /api/sponsor */
export interface SponsorRequest {
  /** Base64 transaction, signed by the user, fee payer slot empty. */
  txBase64: string;
}
export interface SponsorResponse {
  signature: string;
  /** False when the backend co-signed but did not broadcast (mock mode, ephemeral fee payer). */
  broadcast?: boolean;
  /** Worst-case fee the backend accepted responsibility for, in lamports. */
  feeLamports?: string;
  unitsConsumed?: string;
  /** The co-signed transaction, returned only when `broadcast` is false. */
  transactionBase64?: string;
}
/**
 * The backend co-signs only if every instruction targets one of these program ids.
 * ComputeBudget is included so clients can set a priority fee; the backend caps
 * the requested price and unit limit separately.
 */
export const SPONSOR_ALLOWLIST = [
  RELSTATE_PROGRAM,
  TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  ZK_ELGAMAL_PROOF_PROGRAM,
  SYSTEM_PROGRAM, // account creation only
  COMPUTE_BUDGET_PROGRAM,
] as const;

/**
 * Every sponsor call needs a session token, so the spend is attributable to one
 * wallet and the per-wallet caps mean something. `POST /api/auth/mock` issues
 * one in mock mode; the embedded wallet flow issues it in Phase 2.
 */
export interface SessionRequest {
  wallet: string;
}
export interface SessionResponse {
  token: string;
  wallet: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** Contract 3: mirrors the on-chain `Attestation` PDA, seeds ["attestation", wallet]. Written only by the issuer key. */
export interface AttestationView {
  wallet: string;
  /** 0 none, 1 basic KYC, 2 enhanced */
  level: 0 | 1 | 2;
  verifiedAt: number;
  /** sha256(sumsubApplicantId || salt). Lets us prove a link without storing personal data. */
  subjectHash: string;
  issuer: string;
}

/** Contract 4: every external vendor sits behind one of these; `mock` and the real client both implement it. */
export interface ProviderEvent {
  kind: "kyc.approved" | "kyc.rejected" | "onramp.completed" | "offramp.completed";
  wallet: string;
  /** vendor reference, never personal data */
  ref: string;
  amountUsdc?: number;
}
export interface Provider {
  /** Returns a URL (hosted flow) or a token (SDK) for the front end to launch. */
  start(wallet: string, opts?: Record<string, unknown>): Promise<{ url?: string; token?: string }>;
  /** Verify the vendor signature and normalise the payload. Throw on a bad signature. */
  webhook(headers: Record<string, string>, rawBody: string): Promise<ProviderEvent>;
}

/** Contract 6: rUSDC treasury. Amounts are base-unit strings (6 decimals), never JS numbers. */
export interface TreasuryInvariantView {
  /** rUSDC in circulation. */
  supply: string;
  /** USDC backing it. */
  reserve: string;
  /** supply <= reserve */
  ok: boolean;
  headroom: string;
  reserveSource: "onchain" | "mock-ledger";
}
export interface WrapRequest {
  wallet: string;
  /** Base units: 1 USDC = 1000000. */
  amount: string;
  /** Mock mode only: credit the virtual reserve first, standing in for the on-ramp webhook. */
  creditReserve?: boolean;
}
export interface WrapResponse {
  token: string;
  signatures: string[];
  invariant: TreasuryInvariantView;
}
/** POST /api/treasury/confidential-account: wallet-signed setup, treasury pays fee and rent. */
export interface ConfidentialAccountSetupRequest {
  txBase64: string;
}
export interface ConfidentialAccountSetupResponse {
  signature: string;
  broadcast: boolean;
  rentLamports: string;
  transactionBase64?: string;
}

/** GET /health */
export interface HealthResponse {
  ok: boolean;
  mode: "mock" | "live";
  authMode: "mock" | "hmac";
  cluster: string;
  rpc: string;
  rpcIsHelius: boolean;
  feePayer: string;
  attestationIssuer: string;
  treasury: string;
  /** True while a key is a throwaway generated for this process (mock mode with no secrets). */
  ephemeralKeys: string[];
  rusdcMint: string | null;
  auditorConfigured: boolean;
}
