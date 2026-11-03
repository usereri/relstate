// Contracts 2, 3, 4 and 6: shared types between backend, program and app. Change only by agreement.

/** Regenerated in Phase 1 (the old `5J52oGfo7Bj…` had no keypair). See docs/contracts/program-interface.md. */
export const RELSTATE_PROGRAM = "G4iMjveQKXztnGoxigAeWPrb5evT9yt6qaLkgQEp2dXm";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const ZK_ELGAMAL_PROOF_PROGRAM = "ZkE1Gama1Proof11111111111111111111111111111";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
/** SPL Memo v2. Lane A's confidential transfer plan tags its transactions with one. */
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/**
 * Contract 2: GET /api/sponsor — public, no session.
 *
 * The app needs the fee payer address *before* the user signs, because it is
 * part of the signed message. Used as the fallback when `VITE_FEE_PAYER` is
 * unset.
 */
export interface SponsorInfoResponse {
  feePayer: string;
  /**
   * True when the backend is running on a throwaway key (mock mode, no
   * secrets): it can co-sign but cannot pay, and will not broadcast.
   */
  ephemeral: boolean;
  broadcast: boolean;
}

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
 *
 * ComputeBudget is included so clients can set a priority fee; the backend caps
 * the requested price and unit limit separately. Memo is included for Lane A's
 * transfer plan — it holds no state, and a Memo instruction that tried to name
 * the fee payer as a verified signer is rejected by the fee-payer rule anyway.
 */
export const SPONSOR_ALLOWLIST = [
  RELSTATE_PROGRAM,
  TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  ZK_ELGAMAL_PROOF_PROGRAM,
  SYSTEM_PROGRAM, // proof context + account creation only
  COMPUTE_BUDGET_PROGRAM,
  MEMO_PROGRAM,
] as const;

/**
 * Relstate instructions the sponsor will co-sign: every one a lease party or a bound appraiser
 * signs for themselves.
 *
 * The program allowlist above is per PROGRAM, which for relstate is too coarse — it admits
 * `init_config` and `set_admin` as readily as `pay_rent`. Those are signed by the Config admin or
 * the attestation issuer, which are backend keys used by `scripts/*` and `providers/kyc-chain.ts`
 * and never by a browser, so a *sponsored* admin instruction is either a mistake or an attempt. It
 * would fail on chain either way (the program checks the admin), but refusing it here keeps the fee
 * payer's blast radius to what the app actually does, and names the reason instead of returning a
 * simulation failure.
 *
 * **All six mediation instructions are here, and they have to be** (review G2). Mediation has no
 * admin instruction at all now: the two parties drive selection and the appraiser submits the
 * verdict, and none of the three holds SOL. `submit_verdict` in particular is signed by a wallet
 * created at login moments earlier — see {@link ASSOCIATED_TOKEN_PROGRAM} and
 * `txinspect.assertSponsorNotUsedByInstructions` for the one carve-out that makes its token account
 * payable.
 *
 * Snake case, as the program declares them: the wire form is
 * `sha256("global:<name>")[0..8]`, which `txinspect.ts` computes.
 * `test/txinspect.test.ts` pins this list plus {@link ADMIN_ONLY_RELSTATE_INSTRUCTIONS} against
 * every instruction in `app/idl/relstate.json`, so a new one in the program fails there until it is
 * classified as one or the other.
 */
export const SPONSORABLE_RELSTATE_INSTRUCTIONS = [
  "abandon_dispute",
  "accept_deduction",
  "apply",
  "claim_deposit",
  "close_application",
  "close_listing",
  "confirm_appraiser_key",
  "create_listing",
  "escalate_to_mediation",
  "expire_mediation",
  "finalize_deduction",
  "fund_deposit",
  "mark_default",
  "pay_rent",
  "pick_appraiser",
  "propose_appraiser_key",
  "propose_appraisers",
  "propose_lease",
  "release_deposit",
  "settle_dispute",
  "submit_verdict",
] as const;

/**
 * Relstate instructions only the Config admin or the attestation issuer signs. Never sponsored; the
 * list exists so that an unclassified instruction cannot slip into the sponsorable set by default.
 *
 * `register_appraiser`, `set_appraiser_active` and `set_default_appraiser` are gone with the
 * registry: revision 2 of mediation has no admin instruction anywhere in it
 * (docs/contracts/dispute-mediation.md §10 item 1).
 */
export const ADMIN_ONLY_RELSTATE_INSTRUCTIONS = [
  "attest",
  "init_config",
  "revoke",
  "set_admin",
  "set_issuer",
  "set_mint_allowed",
  "set_require_kyc",
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
  /** Unix seconds; 0 means it never expires. The demo issues one year. */
  expiresAt: number;
  /** Set by `revoke()`. The record stays on chain, which is more useful than a hole. */
  revoked: boolean;
  /** sha256(sumsubApplicantId || salt). Lets us prove a link without storing personal data. */
  subjectHash: string;
  issuer: string;
}

/** Contract 4: every external vendor sits behind one of these; `mock` and the real client both implement it. */
export interface ProviderEvent {
  kind: "kyc.approved" | "kyc.rejected" | "onramp.completed" | "offramp.completed";
  wallet: string;
  /**
   * Vendor reference, never personal data. It is also the idempotency key: the
   * on-ramp credits one `ref` exactly once, so it must be the vendor's own event
   * id and not something regenerated per delivery.
   */
  ref: string;
  /** **Base units** (6 decimals), like everything else in the money path: 1 USDC = 1000000. */
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
  authMode: "mock" | "hmac" | "wallet";
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
  /** Workstream E. `mock` means the checkout is a local page and no card is involved. */
  onrampProvider: "mock" | "stripe";
  offrampProvider: "mock";
  /** Workstream D. `mock` means the identity check is a local page and no vendor is involved. */
  kycProvider: "mock" | "sumsub";
  /** Illustrative fixed demo rate, PLN per USDC. */
  plnPerUsdc: string;
}
