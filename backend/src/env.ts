// Contract 5: every tunable in one place, with mock defaults so the backend boots with no secrets.
import { resolve } from "node:path";
import { parsePln, parseRate, parseUsdc } from "./providers/money.ts";

/** Repo root, independent of cwd, so scripts and the server resolve the same .env. */
export const REPO_ROOT = resolve(import.meta.dirname, "../..");

/**
 * Loads `<repo>/.env` then `<repo>/backend/.env`. Real environment variables win
 * over both (Node's loader never overwrites an existing `process.env` entry), so
 * container config beats a stray local file.
 */
export function loadEnvFiles(): void {
  for (const file of [resolve(REPO_ROOT, ".env"), resolve(REPO_ROOT, "backend/.env")]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // absent or unreadable: mock defaults below cover it
    }
  }
}
loadEnvFiles();

const str = (key: string, fallback = ""): string => {
  const v = process.env[key];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
};
const num = (key: string, fallback: number): number => {
  const v = str(key);
  if (v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${key}: not a number (${v})`);
  return n;
};
const bigintOf = (key: string, fallback: bigint): bigint => {
  const v = str(key);
  if (v === "") return fallback;
  try {
    return BigInt(v);
  } catch {
    throw new Error(`env ${key}: not an integer (${v})`);
  }
};

const cluster = str("SOLANA_CLUSTER", "devnet");
const heliusKey = str("HELIUS_API_KEY");

/**
 * Helius when a key is set, else `RPC_URL`, else public devnet. The public
 * endpoint 429s under the multi-transaction confidential-transfer proof plan
 * (Phase 0 result), so `rpc.ts` always wraps whichever URL this resolves to in
 * retry/backoff.
 */
function resolveRpcUrl(): string {
  const explicit = str("RPC_URL");
  if (heliusKey !== "") return `https://${cluster}.helius-rpc.com/?api-key=${heliusKey}`;
  if (explicit !== "") return explicit;
  return cluster === "mainnet-beta" ? "https://api.mainnet-beta.solana.com" : `https://api.${cluster}.solana.com`;
}

const feePayerKeypair = str("FEE_PAYER_KEYPAIR");
const treasuryKeypair = str("TREASURY_KEYPAIR");
const rusdcMint = str("RUSDC_MINT");

export const env = {
  cluster,
  port: num("PORT", 8787),

  rpcUrl: resolveRpcUrl(),
  /** Set when the RPC URL carries a Helius key; used only to redact it in logs and /health. */
  rpcIsHelius: heliusKey !== "",
  rpcMaxRetries: num("RPC_MAX_RETRIES", 8),
  rpcRetryBaseMs: num("RPC_RETRY_BASE_MS", 500),
  rpcRetryMaxMs: num("RPC_RETRY_MAX_MS", 20_000),

  /**
   * `mock` is the no-secrets default: no keypairs are required, the treasury
   * keeps a virtual USDC reserve instead of a real one, and the mock session
   * endpoint is enabled. `live` requires the keys below and refuses to boot without them.
   */
  mode: (str("BACKEND_MODE", "mock") === "live" ? "live" : "mock") as "mock" | "live",
  /**
   * `wallet` is real login: the user signs a one-time challenge with their wallet (wallet-auth.ts).
   * `mock` hands a session to anyone and is refused in live mode.
   */
  authMode: ((): "mock" | "hmac" | "wallet" => {
    const v = str("AUTH_MODE", "mock");
    return v === "hmac" ? "hmac" : v === "wallet" ? "wallet" : "mock";
  })(),
  /** Wallet-login sessions live longer than the 1 h default: re-signing every hour is a bad demo. */
  walletSessionTtlSeconds: num("WALLET_SESSION_TTL_SECONDS", 43_200),
  /** How long a login challenge stays valid. */
  challengeTtlSeconds: num("AUTH_CHALLENGE_TTL_SECONDS", 300),
  /** Trust the `fly-client-ip` header: only true on Fly (FLY_APP_NAME is set by the platform) or when explicitly asked. */
  trustProxyIpHeader: str("FLY_APP_NAME") !== "" || str("TRUST_PROXY_IP_HEADER") === "1",
  /** Requests per minute per client IP to /api/auth/challenge and /api/auth/verify (each). */
  authRatePerMinute: num("AUTH_RATE_PER_MINUTE", 20),
  /** Per IP, across the treasury-key routes: failing requests would otherwise cost nothing. */
  treasuryRatePerMinute: num("TREASURY_RATE_PER_MINUTE", 60),
  /** Per IP, JSON-RPC calls per minute through the read-only `/api/rpc` proxy (a batch counts once per item). */
  rpcProxyRatePerMinute: num("RPC_PROXY_RATE_PER_MINUTE", 600),
  sessionSecret: str("SESSION_SECRET"),
  sessionTtlSeconds: num("SESSION_TTL_SECONDS", 3600),
  adminToken: str("ADMIN_TOKEN"),
  corsOrigin: str("CORS_ORIGIN", "*"),

  // Three distinct keys on purpose; see docs/contracts/treasury.md.
  //   fee payer  pays transaction fees for user-built transactions and nothing else
  //   issuer     signs KYC attestations (workstream D) — never the fee payer
  //   treasury   rUSDC mint + freeze authority, and the only key that funds rent
  feePayerKeypair,
  attestationIssuerKeypair: str("ATTESTATION_ISSUER_KEYPAIR"),
  treasuryKeypair,

  rusdcMint,
  rusdcDecimals: num("RUSDC_DECIMALS", 6),
  /** 32-byte base64 seed for the auditor's ElGamal + AES keys. Backend secret, never shipped to the app. */
  rusdcAuditorIkm: str("RUSDC_AUDITOR_IKM"),
  rusdcAuditorElgamalPubkey: str("RUSDC_AUDITOR_ELGAMAL_PUBKEY"),
  /** Devnet test USDC. Blank in mock mode, where the reserve is a counter. */
  usdcReserveMint: str("USDC_RESERVE_MINT"),
  usdcReserveTokenAccount: str("USDC_RESERVE_TOKEN_ACCOUNT"),

  /** Where the hosted checkout sends the user back to. The app is a hash router, so the return path lives inside the fragment. */
  appUrl: str("APP_URL", "http://localhost:5173"),
  /** True when APP_URL was set explicitly; wallet login binds challenges to its origin. */
  appUrlExplicit: str("APP_URL") !== "",

  /**
   * Fiat in (workstream E, docs/contracts/stripe.md). `mock` is the no-secrets
   * default: the checkout URL points at a local page served by this backend and
   * the "payment" confirms instantly, through the same webhook path as Stripe.
   */
  onramp: {
    provider: (str("ONRAMP_PROVIDER", "mock") === "stripe" ? "stripe" : "mock") as "mock" | "stripe",
    /** Illustrative fixed demo rate; say so on stage. */
    plnPerUsdc: str("DEMO_PLN_PER_USDC", "4.30"),
    minPln: str("ONRAMP_MIN_PLN", "10"),
    maxPln: str("ONRAMP_MAX_PLN", "5000"),
    /** Base units of rUSDC one wallet may be credited in a rolling day. */
    maxUsdcPerWalletPerDay: str("ONRAMP_MAX_USDC_PER_WALLET_PER_DAY", "2000"),
    stripeSecretKey: str("STRIPE_SECRET_KEY"),
    stripeWebhookSecret: str("STRIPE_WEBHOOK_SECRET"),
    /** Comma-separated Stripe payment methods. BLIK needs a PLN-capable account; `card` always works in test mode. */
    stripeApiBase: str("STRIPE_API_BASE", "https://api.stripe.com"),
    /** Stripe's own replay window for webhook timestamps. */
    webhookToleranceSeconds: num("STRIPE_WEBHOOK_TOLERANCE_SECONDS", 300),
  },

  offramp: {
    provider: (str("OFFRAMP_PROVIDER", "mock") === "mock" ? "mock" : "mock") as "mock",
    maxUsdcPerWalletPerDay: str("OFFRAMP_MAX_USDC_PER_WALLET_PER_DAY", "2000"),
  },

  /**
   * Identity (workstream D, docs/contracts/attestation.md). `mock` is the no-secrets default: the
   * verification page is served by this backend and decides instantly, through the same webhook
   * path Sumsub would use. `sumsub` is the real client and refuses to boot without its keys.
   */
  kyc: {
    provider: (str("KYC_PROVIDER", "mock") === "sumsub" ? "sumsub" : "mock") as "mock" | "sumsub",
    /** What an approved check writes on chain: 1 basic, 2 enhanced. */
    level: num("KYC_LEVEL", 1),
    /** Attestation lifetime. 0 writes one that never expires; the demo uses a year. */
    validityDays: num("KYC_VALIDITY_DAYS", 365),
    /**
     * Secret salt for `subject_hash = sha256(applicantId || salt)`. Backend secret, never shipped
     * to the app and never on chain: without it the hash would be confirmable by anyone holding a
     * list of applicant ids.
     */
    subjectSalt: str("KYC_SUBJECT_SALT"),
    /** Signs our outgoing Sumsub API calls (`X-App-Access-Sig`). */
    sumsubAppToken: str("SUMSUB_APP_TOKEN"),
    sumsubSecretKey: str("SUMSUB_SECRET_KEY"),
    /** Verifies incoming Sumsub webhooks (`X-Payload-Digest`). A different secret from the above. */
    sumsubWebhookSecret: str("SUMSUB_WEBHOOK_SECRET"),
    sumsubApiBase: str("SUMSUB_API_BASE", "https://api.sumsub.com"),
    /** The verification level configured in the Sumsub dashboard. */
    sumsubLevelName: str("SUMSUB_LEVEL_NAME", "basic-kyc-level"),
    sumsubLinkTtlSeconds: num("SUMSUB_LINK_TTL_SECONDS", 1800),
    /** Pins the webhook digest algorithm; empty accepts whichever Sumsub's header names. */
    sumsubDigestAlg: str("SUMSUB_WEBHOOK_DIGEST_ALG"),
    /**
     * Sumsub's digest has no timestamp, so a captured delivery replays forever. Events whose own
     * `createdAtMs` is further than this from now are refused, which stops a captured GREEN from
     * re-attesting a revoked wallet after the in-memory dedupe store is lost on restart.
     */
    sumsubMaxEventAgeSeconds: num("SUMSUB_WEBHOOK_MAX_AGE_SECONDS", 600),
    /**
     * Explicit devnet-only override that lets a live backend run the mock verifier. Only the exact
     * value `devnet` counts, and boot additionally checks the RPC's genesis hash (see boot.ts).
     */
    allowMock: str("ALLOW_MOCK_KYC"),
    /** Global budget for the mock verifier's attestations (each one is paid for by the fee payer), in every backend mode. Per process: a restart resets it. 30/h and 100/day (4M x 100). */
    mockMaxAttestsPerHour: num("KYC_MOCK_MAX_ATTESTS_PER_HOUR", 30),
    mockMaxLamportsPerDay: bigintOf("KYC_MOCK_MAX_LAMPORTS_PER_DAY", 400_000_000n),
    /** Booked per attest: ~0.0035 SOL rent for a new account plus fees, rounded up. */
    mockLamportsPerAttest: bigintOf("KYC_MOCK_LAMPORTS_PER_ATTEST", 4_000_000n),
    /** Verification links one wallet may start per hour; each one costs a vendor API call in sumsub mode. */
    maxStartsPerWalletPerHour: num("KYC_MAX_STARTS_PER_WALLET_PER_HOUR", 10),
  },

  sponsor: {
    maxTxBytes: num("SPONSOR_MAX_TX_BYTES", 1232),
    maxInstructions: num("SPONSOR_MAX_INSTRUCTIONS", 16),
    maxComputeUnits: num("SPONSOR_MAX_COMPUTE_UNITS", 400_000),
    maxCuPriceMicroLamports: bigintOf("SPONSOR_MAX_CU_PRICE_MICROLAMPORTS", 10_000n),
    maxFeeLamports: bigintOf("SPONSOR_MAX_FEE_LAMPORTS", 200_000n),
    /** Rent the treasury key may be debited in one setup transaction (~2 token accounts + proof state). */
    maxRentLamports: bigintOf("SPONSOR_MAX_RENT_LAMPORTS", 50_000_000n),
    maxPerWalletPerHour: num("SPONSOR_MAX_PER_WALLET_PER_HOUR", 20),
    maxGlobalPerHour: num("SPONSOR_MAX_GLOBAL_PER_HOUR", 500),
    maxLamportsPerWalletPerDay: bigintOf("SPONSOR_MAX_LAMPORTS_PER_WALLET_PER_DAY", 2_000_000n),
    maxLamportsGlobalPerDay: bigintOf("SPONSOR_MAX_LAMPORTS_GLOBAL_PER_DAY", 50_000_000n),
  },

  /**
   * POST /api/treasury/rent-payment: the treasury funds the proof context-state accounts of a
   * confidential rent payment (docs/contracts/pay.md). The rent comes back when the plan closes
   * them, so these bound the float and the grief, not the cost.
   */
  rentPayment: {
    /**
     * Per context-state account. The three a real plan creates fund 1_468_120 (161 B), 2_606_040
     * (385 B) and 2_159_000 (297 B) lamports on devnet, so 3M is the largest legitimate one with a
     * little headroom, not a round number.
     */
    maxContextLamports: bigintOf("RENT_PAYMENT_MAX_CONTEXT_LAMPORTS", 3_000_000n),
    maxContextSpace: bigintOf("RENT_PAYMENT_MAX_CONTEXT_SPACE", 400n),
    /** The plan creates one per transaction. */
    maxCreateAccounts: num("RENT_PAYMENT_MAX_CREATE_ACCOUNTS", 1),
    /** Most the treasury may be down on ONE transaction, by simulation. */
    maxSpendLamports: bigintOf("RENT_PAYMENT_MAX_SPEND_LAMPORTS", 4_000_000n),
    maxPerWalletPerHour: num("RENT_PAYMENT_MAX_PER_WALLET_PER_HOUR", 30),
    maxGlobalPerHour: num("RENT_PAYMENT_MAX_GLOBAL_PER_HOUR", 300),
    /** A legitimate payment books about 6.3M (its three creates); this allows about four a day. */
    maxLamportsPerWalletPerDay: bigintOf("RENT_PAYMENT_MAX_LAMPORTS_PER_WALLET_PER_DAY", 30_000_000n),
    maxLamportsGlobalPerDay: bigintOf("RENT_PAYMENT_MAX_LAMPORTS_GLOBAL_PER_DAY", 100_000_000n),
  },

  /**
   * POST /api/treasury/rent-dust: the platform provisions the rent a wallet's Application and
   * Profile accounts cost, so that nobody ever holds or acquires SOL. Once per wallet.
   */
  rentDust: {
    maxGlobalPerHour: num("RENT_DUST_MAX_GLOBAL_PER_HOUR", 60),
    maxLamportsGlobalPerDay: bigintOf("RENT_DUST_MAX_LAMPORTS_GLOBAL_PER_DAY", 100_000_000n),
  },
} as const;

export type Env = typeof env;

/** Under 32 characters, or so repetitive it carries little entropy ("aaaa…", "1234…"). */
export function weakSecret(v: string): boolean {
  return v.length < 32 || new Set(v).size < 10;
}

/** URL with the RPC key removed (Helius `?api-key=`, Alchemy `/v2/<key>`), safe for logs and /health. */
export function redactedRpcUrl(url = env.rpcUrl): string {
  return url
    .replace(/([?&]api-key=)[^&]+/i, "$1<redacted>")
    .replace(/(\/v2\/)[^/?#]+/i, "$1<redacted>");
}

/**
 * Fails fast on a configuration that cannot work, instead of at the first
 * request. Mock mode is deliberately permissive: that is what makes
 * `npm run dev` work in a fresh clone with no secrets.
 */
export function assertEnvConsistent(e: Env = env): void {
  const problems: string[] = [];
  if (e.mode === "live") {
    if (e.feePayerKeypair === "") problems.push("FEE_PAYER_KEYPAIR is required when BACKEND_MODE=live");
    if (e.treasuryKeypair === "") problems.push("TREASURY_KEYPAIR is required when BACKEND_MODE=live");
    // Without these two, a live backend would take identity decisions it cannot record: no key to
    // sign the attestation, and no stable salt, so the same applicant would hash differently
    // after every restart and the chain would hold hashes nothing can be checked against.
    if (e.attestationIssuerKeypair === "") problems.push("ATTESTATION_ISSUER_KEYPAIR is required when BACKEND_MODE=live");
    if (e.kyc.subjectSalt === "") problems.push("KYC_SUBJECT_SALT is required when BACKEND_MODE=live (any high-entropy string; keep it secret and stable)");
    if (e.rusdcMint === "") problems.push("RUSDC_MINT is required when BACKEND_MODE=live (run scripts/make-rusdc.ts)");
    if (e.authMode === "mock") problems.push("AUTH_MODE=mock is refused when BACKEND_MODE=live");
    if (e.authMode === "hmac") problems.push("AUTH_MODE=hmac has no login route and is refused when BACKEND_MODE=live (use AUTH_MODE=wallet)");
    if (weakSecret(e.sessionSecret) && e.sessionSecret !== "") problems.push("SESSION_SECRET is too weak: use at least 32 characters with real entropy (e.g. openssl rand -base64 32)");
    if (weakSecret(e.adminToken) && e.adminToken !== "") problems.push("ADMIN_TOKEN is too weak: use at least 32 characters with real entropy (e.g. openssl rand -base64 32)");
    // Live mode forces a real issuer key into place, so the mock verifier's unsigned "Approve"
    // button would write real attestations signed by it. KYC_PROVIDER defaults to mock, so this
    // has to be refused by name rather than hoped for.
    if (e.kyc.provider === "mock" && !(e.kyc.allowMock === "devnet" && e.cluster === "devnet")) {
      problems.push("KYC_PROVIDER=mock is refused when BACKEND_MODE=live (set KYC_PROVIDER=sumsub, or on devnet only ALLOW_MOCK_KYC=devnet with SOLANA_CLUSTER=devnet)");
    }
    if (e.authMode === "wallet" && !e.appUrlExplicit) problems.push("APP_URL is required when AUTH_MODE=wallet (login challenges are bound to its origin)");
    if (e.sessionSecret === "") problems.push("SESSION_SECRET is required when BACKEND_MODE=live");
    if (e.adminToken === "") problems.push("ADMIN_TOKEN is required when BACKEND_MODE=live");
  }
  // The fee payer signs anything a user submits; the issuer vouches for identity.
  // One key doing both would let a crafted sponsored transaction speak as the issuer.
  if (e.feePayerKeypair !== "" && e.feePayerKeypair === e.attestationIssuerKeypair) {
    problems.push("FEE_PAYER_KEYPAIR and ATTESTATION_ISSUER_KEYPAIR must be different keys");
  }
  if (e.feePayerKeypair !== "" && e.feePayerKeypair === e.treasuryKeypair) {
    problems.push("FEE_PAYER_KEYPAIR and TREASURY_KEYPAIR must be different keys");
  }
  // The treasury mints money; the issuer vouches for people. Sharing one key means a compromise of
  // either is a compromise of both, and the on-chain issuer check would no longer mean anything
  // beyond "the backend's main key".
  if (e.treasuryKeypair !== "" && e.treasuryKeypair === e.attestationIssuerKeypair) {
    problems.push("TREASURY_KEYPAIR and ATTESTATION_ISSUER_KEYPAIR must be different keys");
  }
  if (e.kyc.allowMock !== "" && e.kyc.allowMock !== "devnet") problems.push(`ALLOW_MOCK_KYC must be exactly "devnet" or unset, not "${e.kyc.allowMock}"`);
  if (!(e.kyc.mockMaxAttestsPerHour > 0) || !(e.kyc.mockMaxLamportsPerDay > 0n) || !(e.kyc.mockLamportsPerAttest > 0n)) {
    problems.push("KYC_MOCK_MAX_ATTESTS_PER_HOUR, KYC_MOCK_MAX_LAMPORTS_PER_DAY and KYC_MOCK_LAMPORTS_PER_ATTEST must be greater than zero");
  }
  if (!(e.walletSessionTtlSeconds > 0) || !(e.challengeTtlSeconds > 0) || !(e.authRatePerMinute > 0)) {
    problems.push("WALLET_SESSION_TTL_SECONDS, AUTH_CHALLENGE_TTL_SECONDS and AUTH_RATE_PER_MINUTE must be greater than zero");
  }
  // A half-configured Sumsub is worse than no Sumsub: a verification the webhook can never verify
  // would send a user through a real document check and attest nobody.
  if (e.kyc.provider === "sumsub") {
    if (e.kyc.sumsubAppToken === "") problems.push("SUMSUB_APP_TOKEN is required when KYC_PROVIDER=sumsub");
    if (e.kyc.sumsubSecretKey === "") problems.push("SUMSUB_SECRET_KEY is required when KYC_PROVIDER=sumsub");
    if (e.kyc.sumsubWebhookSecret === "") problems.push("SUMSUB_WEBHOOK_SECRET is required when KYC_PROVIDER=sumsub (it is set separately from SUMSUB_SECRET_KEY in the dashboard)");
    if (e.kyc.sumsubLevelName === "") problems.push("SUMSUB_LEVEL_NAME is required when KYC_PROVIDER=sumsub");
  }
  // The program refuses anything else, so catching it here saves a webhook that can never land.
  if (!(e.kyc.sumsubMaxEventAgeSeconds > 0)) problems.push("SUMSUB_WEBHOOK_MAX_AGE_SECONDS must be greater than zero");
  if (!(e.kyc.maxStartsPerWalletPerHour > 0)) problems.push("KYC_MAX_STARTS_PER_WALLET_PER_HOUR must be greater than zero");
  if (e.kyc.level !== 1 && e.kyc.level !== 2) problems.push(`KYC_LEVEL must be 1 (basic) or 2 (enhanced), not ${e.kyc.level}`);
  if (!Number.isInteger(e.kyc.validityDays) || e.kyc.validityDays < 0) problems.push("KYC_VALIDITY_DAYS must be a non-negative whole number of days (0 = never expires)");
  // The on-ramp is the one path that mints rUSDC without a user signature, so a
  // half-configured Stripe is worse than no Stripe: a checkout the webhook can
  // never verify would take (test) money and credit nobody.
  if (e.onramp.provider === "stripe") {
    if (e.onramp.stripeSecretKey === "") problems.push("STRIPE_SECRET_KEY is required when ONRAMP_PROVIDER=stripe");
    if (e.onramp.stripeWebhookSecret === "") problems.push("STRIPE_WEBHOOK_SECRET is required when ONRAMP_PROVIDER=stripe");
  }
  try {
    parseRate(e.onramp.plnPerUsdc);
    parsePln(e.onramp.minPln, "ONRAMP_MIN_PLN");
    parsePln(e.onramp.maxPln, "ONRAMP_MAX_PLN");
    parseUsdc(e.onramp.maxUsdcPerWalletPerDay, "ONRAMP_MAX_USDC_PER_WALLET_PER_DAY");
    parseUsdc(e.offramp.maxUsdcPerWalletPerDay, "OFFRAMP_MAX_USDC_PER_WALLET_PER_DAY");
    if (parseRate(e.onramp.plnPerUsdc) <= 0n) problems.push("DEMO_PLN_PER_USDC must be greater than zero");
    if (parsePln(e.onramp.minPln) > parsePln(e.onramp.maxPln)) problems.push("ONRAMP_MIN_PLN is above ONRAMP_MAX_PLN");
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (problems.length > 0) throw new Error(`invalid configuration:\n  - ${problems.join("\n  - ")}`);
}
