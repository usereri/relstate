// Phase 1, step 8: the one RPC entry point for the backend and for scripts/.
//
// Phase 0 found that the public devnet endpoint 429s partway through the
// confidential-transfer proof plan, which is a multi-transaction sequence that
// cannot be restarted cheaply. So every request here goes through retry with
// exponential backoff and honours `Retry-After`. Helius is used when a key is
// configured; without one we fall back to the public endpoint with the same
// backoff rather than failing.
import {
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  assertIsSendableTransaction,
  assertIsTransactionWithBlockhashLifetime,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  createTransactionPlanExecutor,
  createTransactionPlanner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isSolanaError,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Blockhash,
  type InstructionPlan,
  type RpcTransport,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import { env, redactedRpcUrl } from "./env.ts";

export type RetryConfig = {
  maxRetries: number;
  baseMs: number;
  maxMs: number;
  sleep: (ms: number) => Promise<void>;
  /** Injectable for deterministic tests; must return [0, 1). */
  random: () => number;
};

export const defaultRetryConfig: RetryConfig = {
  maxRetries: env.rpcMaxRetries,
  baseMs: env.rpcRetryBaseMs,
  maxMs: env.rpcRetryMaxMs,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: Math.random,
};

/** 429 plus the 5xx range: the statuses a public or rate-limited RPC returns transiently. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

/**
 * Exponential backoff with full jitter, clamped to `maxMs`. A `Retry-After`
 * header wins outright — a rate limiter telling us when to come back is better
 * information than our own guess.
 */
export function nextDelayMs(attempt: number, retryAfterMs: number | undefined, cfg: RetryConfig): number {
  if (retryAfterMs !== undefined && retryAfterMs >= 0) return Math.min(retryAfterMs, cfg.maxMs);
  const ceiling = Math.min(cfg.baseMs * 2 ** attempt, cfg.maxMs);
  return Math.round(ceiling * (0.5 + 0.5 * cfg.random()));
}

/** `Retry-After` is either seconds or an HTTP date. Returns milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (value === null || value === undefined || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Network-level failures worth another try: no HTTP status, but not a bug either. */
function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) {
    return true;
  }
  return error.name === "TypeError" && /fetch failed|network|socket/i.test(error.message);
}

function httpErrorOf(error: unknown): { statusCode: number; retryAfterMs: number | undefined } | undefined {
  if (!isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return undefined;
  return {
    statusCode: error.context.statusCode,
    retryAfterMs: parseRetryAfter(error.context.headers?.get("retry-after")),
  };
}

/**
 * Drop-in `fetch` with the same backoff policy, for the plain HTTP calls that
 * do not go through an `Rpc` object (faucet, provider webhooks, health probes).
 */
export async function retryingFetch(
  input: string | URL | Request,
  init?: RequestInit,
  cfg: Partial<RetryConfig> = {},
): Promise<Response> {
  const c = { ...defaultRetryConfig, ...cfg };
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (error) {
      if (attempt >= c.maxRetries || !isTransientNetworkError(error)) throw error;
      await c.sleep(nextDelayMs(attempt, undefined, c));
      continue;
    }
    if (!isRetryableStatus(response.status) || attempt >= c.maxRetries) return response;
    await c.sleep(nextDelayMs(attempt, parseRetryAfter(response.headers.get("retry-after")), c));
  }
}

/** Wraps kit's default transport so every RPC method inherits the backoff. */
export function createRetryingTransport(url: string, cfg: Partial<RetryConfig> = {}): RpcTransport {
  const c = { ...defaultRetryConfig, ...cfg };
  const inner = createDefaultRpcTransport({ url });
  return async function retryingTransport<TResponse>(config: Parameters<RpcTransport>[0]) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await inner<TResponse>(config);
      } catch (error) {
        const http = httpErrorOf(error);
        const retryable = http !== undefined ? isRetryableStatus(http.statusCode) : isTransientNetworkError(error);
        if (!retryable || attempt >= c.maxRetries) throw error;
        await c.sleep(nextDelayMs(attempt, http?.retryAfterMs, c));
      }
    }
  };
}

export type SolanaClient = ReturnType<typeof createSolanaClient>;

export function createSolanaClient(url: string = env.rpcUrl, cfg: Partial<RetryConfig> = {}) {
  const rpc = createSolanaRpcFromTransport(createRetryingTransport(url, cfg));
  const wsUrl = url.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  // Subscriptions are created lazily: nothing that only reads accounts should
  // pay for a websocket, and `npm run dev` in mock mode opens none at all.
  let subscriptions: ReturnType<typeof createSolanaRpcSubscriptions> | undefined;
  const rpcSubscriptions = () => (subscriptions ??= createSolanaRpcSubscriptions(wsUrl));

  return {
    rpc,
    rpcSubscriptions,
    url,
    wsUrl,
    redactedUrl: redactedRpcUrl(url),
    sendAndConfirm: (...args: Parameters<ReturnType<typeof sendAndConfirmTransactionFactory>>) =>
      sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: rpcSubscriptions() })(...args),
  };
}

let shared: SolanaClient | undefined;
/** The process-wide client. One connection pool, one backoff policy. */
export function getSolanaClient(): SolanaClient {
  return (shared ??= createSolanaClient());
}

export type ConfirmOptions = {
  commitment: "confirmed" | "finalized";
  pollMs: number;
  timeoutMs: number;
  /** Re-send every this many polls: a transaction sent once can still be dropped. */
  resendEveryPolls: number;
};

export const defaultConfirmOptions: ConfirmOptions = {
  commitment: "confirmed",
  pollMs: 700,
  timeoutMs: 90_000,
  resendEveryPolls: 6,
};

/**
 * Sends a transaction and confirms it by polling `getSignatureStatuses`.
 *
 * Deliberately not kit's `sendAndConfirmTransactionFactory`, which confirms over
 * a websocket subscription. `wss://api.devnet.solana.com` drops connections
 * under exactly the load a confidential-transfer proof plan generates, and a
 * dropped socket fails the whole plan several transactions in — which is how
 * this was found. Polling goes through the retrying HTTP transport, so it
 * inherits the 429 backoff that the rest of this module provides, and a
 * dropped response is just another retry.
 */
export async function sendAndConfirmByPolling(
  client: SolanaClient,
  transaction: Parameters<typeof getBase64EncodedWireTransaction>[0] & Parameters<typeof getSignatureFromTransaction>[0],
  options: Partial<ConfirmOptions> & {
    skipPreflight?: boolean;
    /** The transaction's blockhash, so expiry can be detected instead of waiting out the timeout. */
    blockhash?: Blockhash;
  } = {},
): Promise<Signature> {
  const o = { ...defaultConfirmOptions, ...options };
  const wire = getBase64EncodedWireTransaction(transaction);
  const signature = getSignatureFromTransaction(transaction);
  const send = () =>
    client.rpc
      .sendTransaction(wire, {
        encoding: "base64",
        skipPreflight: options.skipPreflight ?? false,
        preflightCommitment: o.commitment,
        // We do our own re-sending below, in step with the polling.
        maxRetries: 0n,
      })
      .send();

  await send();
  const deadline = Date.now() + o.timeoutMs;
  for (let poll = 1; Date.now() < deadline; poll++) {
    await new Promise((resolve) => setTimeout(resolve, o.pollMs));
    const { value } = await client.rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status != null) {
      if (status.err != null) {
        throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err)}`);
      }
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") return signature;
    } else if (poll % o.resendEveryPolls === 0) {
      // Not seen yet: either still propagating or dropped. Re-sending is cheap
      // and idempotent; the blockhash check stops us trying past expiry.
      if (options.blockhash !== undefined) {
        const { value: stillValid } = await client.rpc.isBlockhashValid(options.blockhash, { commitment: o.commitment }).send();
        if (!stillValid) throw new Error(`transaction ${signature} expired before it was confirmed`);
      }
      await send();
    }
  }
  throw new Error(`transaction ${signature} was not confirmed within ${o.timeoutMs}ms`);
}

/**
 * Runs an instruction plan the way `spikes/ct` proved out on devnet: version 0
 * messages, a fresh blockhash per transaction, and deliberately **no**
 * compute-unit estimation. The confidential-transfer plans carry their range
 * proof inline and sit within a few bytes of the size limit, so an injected
 * SetComputeUnitLimit instruction pushes them over it.
 */
export function createPlanRunner(
  client: SolanaClient = getSolanaClient(),
  log: (...args: unknown[]) => void = () => {},
  confirm: Partial<ConfirmOptions> = {},
) {
  const signatures: Signature[] = [];
  const executor = createTransactionPlanExecutor({
    executeTransactionMessage: async (_ctx, message) => {
      const { value: blockhash } = await client.rpc.getLatestBlockhash().send();
      const transaction = await signTransactionMessageWithSigners(setTransactionMessageLifetimeUsingBlockhash(blockhash, message));
      assertIsSendableTransaction(transaction);
      assertIsTransactionWithBlockhashLifetime(transaction);
      const signature = await sendAndConfirmByPolling(client, transaction, { ...confirm, blockhash: blockhash.blockhash });
      log("   tx", signature);
      signatures.push(signature);
      return { signature, transaction };
    },
  });

  return async function run(payer: TransactionSigner, plan: InstructionPlan, label: string): Promise<Signature[]> {
    log(`-> ${label}`);
    const planner = createTransactionPlanner({
      createTransactionMessage: () =>
        pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m)),
    });
    const before = signatures.length;
    await executor(await planner(plan));
    return signatures.slice(before);
  };
}
