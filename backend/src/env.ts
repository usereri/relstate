// Contract 5: every tunable in one place, with mock defaults so the backend boots with no secrets.
import { resolve } from "node:path";

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
  authMode: (str("AUTH_MODE", "mock") === "hmac" ? "hmac" : "mock") as "mock" | "hmac",
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
} as const;

export type Env = typeof env;

/** URL with the Helius key removed, safe for logs and /health. */
export function redactedRpcUrl(url = env.rpcUrl): string {
  return url.replace(/([?&]api-key=)[^&]+/i, "$1<redacted>");
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
    if (e.rusdcMint === "") problems.push("RUSDC_MINT is required when BACKEND_MODE=live (run scripts/make-rusdc.ts)");
    if (e.authMode === "mock") problems.push("AUTH_MODE=mock is refused when BACKEND_MODE=live");
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
  if (problems.length > 0) throw new Error(`invalid configuration:\n  - ${problems.join("\n  - ")}`);
}
