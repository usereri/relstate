// Contracts 2, 3 and 4: shared types between backend, program and app. Change only by agreement.

/** Contract 2: POST /api/sponsor */
export interface SponsorRequest {
  /** Base64 transaction, signed by the user, fee payer slot empty. */
  txBase64: string;
}
export interface SponsorResponse {
  signature: string;
}
/** The backend co-signs only if every instruction targets one of these program ids. */
export const SPONSOR_ALLOWLIST = [
  "5J52oGfo7BjC529vizEaM96QtxVFD4Kbv22Tw8aXa1Ar", // relstate
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // associated token
  "ZkE1Gama1Proof11111111111111111111111111111", // ZK ElGamal proof
  "11111111111111111111111111111111", // system (account creation only)
] as const;

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
