// Phase 1, step 9: the backend skeleton. Hono, one health route, the hardened
// sponsor endpoint, and the treasury operations. No providers yet — workstream C
// adds the webhook routes on top of this.
import { isAddress, type Address, type Signature } from "@solana/kit";
import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { VerdictRefused, fetchAppraiser } from "./appraiser-chain.ts";
import { appraiserNameHash, hex } from "./appraisers.ts";
import { AuthError, assertAdmin, assertVerdictConsole, createSessionToken, sessionFromAuthorizationHeader } from "./auth.ts";
import { verifyRentPayment } from "./confidential.ts";
import { RELSTATE_PROGRAM, type HealthResponse, type SponsorInfoResponse, type SponsorRequest, type TreasuryInvariantView } from "./contracts.ts";
import { env, redactedRpcUrl } from "./env.ts";
import { LeaseDecodeError, LeaseNotFound, fetchLease, type DecodedLease } from "./lease.ts";
import { LimitError } from "./limits.ts";
import { KycError, mockVerificationPage } from "./providers/kyc.ts";
import { SumsubApiError } from "./providers/kyc-sumsub.ts";
import { formatPln, formatUsdc, parsePln, parseUsdc } from "./providers/money.ts";
import { OnrampError, WebhookError, formatRate, mockCheckoutPage } from "./providers/onramp.ts";
import { StripeApiError } from "./providers/stripe.ts";
import { ServiceUnavailable, createServices, type Services } from "./services.ts";
import { InvariantViolation, reportForLog, type InvariantReport } from "./treasury.ts";
import { clientIpOf, createIpLimiter, createWalletAuth, RateLimited, type WalletAuth } from "./wallet-auth.ts";
import { RejectedTransaction } from "./txinspect.ts";
import { loadIdl } from "./layout.ts";
import { createRpcLimiter, createRpcProxy, RPC_PROXY_MAX_BODY_BYTES, type RpcProxy } from "./rpcproxy.ts";

const asInvariantView = (report: InvariantReport): TreasuryInvariantView => reportForLog(report);

/** Maps a thrown error to a status and a message safe to return to a caller. */
function problem(error: unknown): { status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 | 503; body: Record<string, unknown> } {
  if (error instanceof RejectedTransaction) return { status: 400, body: { error: error.message, code: error.code } };
  if (error instanceof VerdictRefused) return { status: 409, body: { error: error.message, code: error.code } };
  if (error instanceof AuthError) return { status: 401, body: { error: error.message, code: "unauthorized" } };
  if (error instanceof RateLimited) return { status: 429, body: { error: error.message, code: "rate-limited", scope: "ip" } };
  if (error instanceof LimitError) return { status: 429, body: { error: error.message, code: "rate-limited", scope: error.scope } };
  // A rejected webhook is the caller's problem, not ours: 400 so a genuine
  // provider retry of a *valid* event is still possible, and nothing about the
  // signing secret leaks into the message.
  if (error instanceof WebhookError) return { status: 400, body: { error: error.message, code: error.code } };
  if (error instanceof OnrampError) return { status: error.status, body: { error: error.message, code: error.code } };
  if (error instanceof KycError) return { status: error.status, body: { error: error.message, code: error.code } };
  if (error instanceof SumsubApiError) {
    return { status: 502, body: { error: `the identity provider rejected the request: ${error.message}`, code: error.sumsubCode ?? "provider-error" } };
  }
  if (error instanceof StripeApiError) {
    return { status: 502, body: { error: `the payment provider rejected the request: ${error.message}`, code: error.stripeCode ?? "provider-error" } };
  }
  if (error instanceof InvariantViolation) {
    return {
      status: 409,
      body: {
        error: error.message,
        code: "reserve-invariant",
        supply: error.supply.toString(),
        reserve: error.reserve.toString(),
      },
    };
  }
  if (error instanceof ServiceUnavailable) return { status: 503, body: { error: error.message, code: "unavailable" } };
  // Our bug, not the caller's, but a silent "internal error" would hide the one thing worth
  // knowing: this backend's hand-written Lease layout no longer matches the deployed program.
  if (error instanceof LeaseDecodeError) return { status: 500, body: { error: error.message, code: "lease-layout" } };
  // Anything else is a bug or an upstream failure: log it, return nothing specific.
  console.error("unhandled error:", error);
  return { status: 500, body: { error: "internal error", code: "internal" } };
}

async function readJson<T>(c: { req: { json(): Promise<unknown> } }): Promise<T> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw new RejectedTransaction("body must be JSON", "malformed-body");
  }
  // `null`, a number or an array parses fine and then throws a TypeError on the first property read,
  // which would surface as a 500. Every caller expects an object.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RejectedTransaction("body must be a JSON object", "malformed-body");
  }
  return parsed as T;
}

/**
 * A verdict deduction: base-unit digits only, as a string, or a safe non-negative integer. Not
 * `BigInt(x)`, which maps "", " ", true, [] and "0x10" to values and would turn an empty form field
 * into a live verdict of 0.
 */
export function parseDeduction(value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value) && value.length <= 20) {
    const n = BigInt(value);
    if (n <= 18_446_744_073_709_551_615n) return n;
  }
  throw new RejectedTransaction("deduction must be a non-negative base-unit integer (digits only)", "malformed-body");
}

/** A flag that, if present, must be a real boolean: "true", 1 and "yes" are refused, not guessed at. */
export function parseOptionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  throw new RejectedTransaction(`${field} must be true or false`, "malformed-body");
}

/** Positive base-unit amount from an untrusted string. */
function parseAmount(value: unknown, field = "amount"): bigint {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new RejectedTransaction(`${field} must be a base-unit integer string`, "malformed-body");
  }
  let amount: bigint;
  try {
    amount = BigInt(value);
  } catch {
    throw new RejectedTransaction(`${field} is not an integer: ${String(value)}`, "malformed-body");
  }
  if (amount <= 0n) throw new RejectedTransaction(`${field} must be positive`, "malformed-body");
  return amount;
}

/**
 * The URL the mock checkout page may send the browser back to.
 *
 * Compared by **origin**, not by prefix: `http://localhost:5173.evil.test/`
 * starts with `http://localhost:5173` and is a different site, so a prefix check
 * turns this page into an open redirector. Anything that is not the app's own
 * origin falls back to the configured one.
 */
export function safeReturnBase(requested: string | undefined, appUrl = env.appUrl, fallbackFragment = "/#/app?tab=wallet&topup="): string {
  const fallback = `${appUrl.replace(/\/$/, "")}${fallbackFragment}`;
  if (requested === undefined || requested === "") return fallback;
  try {
    return new URL(requested).origin === new URL(appUrl).origin ? requested : fallback;
  } catch {
    // Not an absolute URL at all: a relative "back" would resolve against this
    // backend's origin, not the app's, so it is no use either.
    return fallback;
  }
}

/** The program's account discriminators from the IDL on disk, or null when a deploy carries none. */
function idlDiscriminators(): Uint8Array[] | null {
  const accounts = loadIdl()?.accounts;
  return accounts && accounts.length > 0 ? accounts.map((a) => Uint8Array.from(a.discriminator)) : null;
}

export function createApp(
  services: Services = createServices(),
  walletAuth: WalletAuth | undefined = env.authMode === "wallet" ? createWalletAuth() : undefined,
  rpcProxy: RpcProxy = createRpcProxy({ upstreamUrl: () => env.rpcUrl, secrets: () => env.rpcSecrets, discriminators: idlDiscriminators }),
) {
  const app = new Hono();
  app.use("*", cors({ origin: env.corsOrigin, allowHeaders: ["content-type", "authorization", "solana-client"], allowMethods: ["GET", "POST", "OPTIONS"] }));

  app.onError((error, c) => {
    const { status, body } = problem(error);
    return c.json(body, status);
  });

  /**
   * Deliberately resolves the keys but never the RPC: the gate for this lane is
   * that the backend answers here with no secrets and no network.
   */
  app.get("/health", async (c) => {
    const keys = await services.keyReport();
    const body: HealthResponse = {
      ok: true,
      mode: env.mode,
      authMode: env.authMode,
      cluster: env.cluster,
      rpc: redactedRpcUrl(),
      rpcIsHelius: env.rpcIsHelius,
      feePayer: keys.feePayer,
      attestationIssuer: keys.attestationIssuer,
      treasury: keys.treasury,
      ephemeralKeys: keys.ephemeral,
      rusdcMint: env.rusdcMint === "" ? null : env.rusdcMint,
      auditorConfigured: env.rusdcAuditorIkm !== "",
      onrampProvider: env.onramp.provider,
      offrampProvider: env.offramp.provider,
      kycProvider: env.kyc.provider,
      plnPerUsdc: formatRate(services.onramp().rateScaled),
    };
    return c.json(body);
  });

  /**
   * Mock session issuance: hands a real HMAC session to any wallet that asks.
   * Enabled only when AUTH_MODE=mock, and `assertEnvConsistent` refuses that
   * combination in live mode. Phase 2 replaces this with the embedded-wallet
   * login, which will issue the same token shape.
   */
  if (env.authMode === "mock") {
    app.post("/api/auth/mock", async (c) => {
      limit(`m:${clientIp(c)}`);
      const { wallet } = await readJson<{ wallet?: string }>(c);
      if (typeof wallet !== "string" || wallet.trim() === "") {
        throw new RejectedTransaction("wallet is required", "malformed-body");
      }
      // Defence in depth: the sponsor also refuses such a session, but this
      // route is open to anyone in mock mode and the fee payer address is
      // public, so do not hand one out in the first place.
      const sponsor = await services.sponsor();
      if (wallet.trim() === sponsor.feePayer) {
        throw new RejectedTransaction("refusing to issue a session for the fee payer's own address", "wallet-is-sponsor");
      }
      const { token, expiresAt } = createSessionToken(wallet);
      return c.json({ token, wallet, expiresAt });
    });
  }

  // Per-IP limiter for the unauthenticated session-issuing routes (wallet login and mock sessions).
  const limit = createIpLimiter(env.authRatePerMinute);
  const treasuryLimit = createIpLimiter(env.treasuryRatePerMinute);
  const clientIp = (c: Parameters<typeof getConnInfo>[0]): string => {
    let socket: string | undefined;
    try {
      socket = getConnInfo(c).remote.address;
    } catch {
      socket = undefined;
    }
    return clientIpOf((n) => c.req.header(n), socket, env.trustProxyIpHeader);
  };

  /**
   * Read-only JSON-RPC proxy for the browser (see rpcproxy.ts). Public on purpose: it carries no
   * session and does only what the allowlist there permits. It has its own work-weighted limiter
   * (per IP and process-wide) and requires `application/json`, which makes a cross-origin request
   * preflighted instead of "simple".
   */
  const rpcAdmit = createRpcLimiter({ perIpPerMinute: env.rpcProxyRatePerMinute, globalPerMinute: env.rpcProxyGlobalPerMinute });
  app.post(
    "/api/rpc",
    bodyLimit({
      maxSize: RPC_PROXY_MAX_BODY_BYTES,
      onError: (c) => c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "request too large" } }, 413),
    }),
    async (c) => {
      if (!/^application\/json\s*(;|$)/i.test(c.req.header("content-type") ?? "")) {
        return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "content-type must be application/json" } }, 415);
      }
      const ip = clientIp(c);
      const result = await rpcProxy.handle(await c.req.text(), (weight) => rpcAdmit(`rpc:${ip}`, weight));
      if (result.retryAfter) c.header("retry-after", result.retryAfter);
      return c.body(result.body, result.status as 200, { "content-type": "application/json" });
    },
  );

  /** Wallet-signature login. Only mounted when AUTH_MODE=wallet; see wallet-auth.ts. */
  if (walletAuth !== undefined) {
    app.post("/api/auth/challenge", async (c) => {
      limit(`c:${clientIp(c)}`);
      const { wallet } = await readJson<{ wallet?: unknown }>(c);
      return c.json(walletAuth.challenge(wallet));
    });
    app.post("/api/auth/verify", async (c) => {
      limit(`v:${clientIp(c)}`);
      const { wallet, nonce, signature } = await readJson<{ wallet?: unknown; nonce?: unknown; signature?: unknown }>(c);
      return c.json(walletAuth.verifyLogin(wallet, nonce, signature));
    });
  }

  /**
   * The app needs the fee payer address before the user signs, because the fee
   * payer is part of the signed message and a 0-SOL wallet cannot discover it
   * any other way. Public and unauthenticated: it is a public key.
   */
  app.get("/api/sponsor", async (c) => {
    const sponsor = await services.sponsor();
    const body: SponsorInfoResponse = {
      feePayer: sponsor.feePayer,
      ephemeral: !sponsor.broadcast,
      broadcast: sponsor.broadcast,
    };
    return c.json(body);
  });

  app.post("/api/sponsor", async (c) => {
    treasuryLimit(`t:${clientIp(c)}`);
    const session = sessionFromAuthorizationHeader(c.req.header("authorization"));
    const { txBase64 } = await readJson<SponsorRequest>(c);
    if (typeof txBase64 !== "string" || txBase64 === "") {
      throw new RejectedTransaction("txBase64 is required", "malformed-body");
    }
    const sponsor = await services.sponsor();
    const result = await sponsor.sponsor({ txBase64, wallet: session.wallet });
    return c.json(result);
  });

  /** First-use confidential account: the wallet signed it, the treasury pays fee and rent. */
  app.post("/api/treasury/confidential-account", async (c) => {
    treasuryLimit(`t:${clientIp(c)}`);
    const session = sessionFromAuthorizationHeader(c.req.header("authorization"));
    const { txBase64 } = await readJson<{ txBase64?: string }>(c);
    if (typeof txBase64 !== "string" || txBase64 === "") {
      throw new RejectedTransaction("txBase64 is required", "malformed-body");
    }
    const treasury = await services.treasury();
    return c.json(await treasury.sponsorConfidentialAccountSetup({ txBase64, wallet: session.wallet }));
  });

  /**
   * One transaction of a confidential rent payment, co-signed by the TREASURY.
   *
   * Not `/api/sponsor`, whose rule (the fee payer never appears inside an instruction) stays
   * absolute: the proof plan funds its context-state accounts from the payer, so every transaction
   * of it would be refused there. The treasury is confined to the few positions that are harmless
   * (`rentshape.ts`), the session wallet must be the paying tenant, and the route has its own
   * limiter and replay guard.
   */
  app.post("/api/treasury/rent-payment", async (c) => {
    treasuryLimit(`t:${clientIp(c)}`);
    const session = sessionFromAuthorizationHeader(c.req.header("authorization"));
    const { txBase64 } = await readJson<{ txBase64?: string }>(c);
    if (typeof txBase64 !== "string" || txBase64 === "") {
      throw new RejectedTransaction("txBase64 is required", "malformed-body");
    }
    const treasury = await services.treasury();
    return c.json(await treasury.sponsorRentPayment({ txBase64, wallet: session.wallet }));
  });

  /**
   * The platform provisions the rent a tenant's Application and Profile cost, so nobody ever holds or
   * acquires SOL. Bound to the session wallet (a body that names another wallet is refused, not
   * obeyed), once per wallet, never to a wallet that already holds enough.
   */
  app.post("/api/treasury/rent-dust", async (c) => {
    treasuryLimit(`t:${clientIp(c)}`);
    const session = sessionFromAuthorizationHeader(c.req.header("authorization"));
    const body = ((await c.req.json().catch(() => null)) ?? {}) as { wallet?: unknown };
    if (body.wallet !== undefined && body.wallet !== session.wallet) {
      throw new RejectedTransaction("rent dust can only be requested for the session's own wallet", "wallet-mismatch");
    }
    const sponsor = await services.sponsor();
    if (session.wallet === sponsor.feePayer) {
      throw new RejectedTransaction("the fee payer does not need rent dust", "wallet-is-sponsor");
    }
    const treasury = await services.treasury();
    return c.json(await treasury.grantRentDust({ wallet: session.wallet }));
  });

  /**
   * The after-the-fact amount check — the mechanism the auditor key exists for.
   *
   * `pay_rent` credits `lease.rent_amount` whatever was actually sent, because the amount is
   * encrypted and the program cannot see it (docs/privacy.md, "What pay_rent can and cannot
   * enforce"). This route closes that gap: it pairs the confidential `Transfer` directly before the
   * `pay_rent` instruction — the program's own layout rule, so exactly one transfer answers for
   * exactly one recorded payment — decrypts it with the auditor key, and compares against the rent
   * the program itself wrote on the lease.
   *
   * Three deliberate choices:
   *
   * - **The expected amount is read from the chain**, never from the request. A body that could
   *   name its own `expectedAmount` would make this endpoint a rubber stamp.
   * - **Only the two parties may ask.** The answer is a rent amount, which is the one thing
   *   `docs/privacy.md` promises to keep private, so the session wallet must be the lease's tenant
   *   or its landlord. A stranger gets 404 and learns nothing, not even that the lease exists.
   * - **A mismatch is a 200, not an error.** "This payment settled the wrong amount" is a
   *   successful audit with a negative result; it is `ok: false` in the body, for the caller to act
   *   on. Only a failure to *perform* the check is an error status.
   */
  app.post("/api/rent/verify", async (c) => {
    const session = sessionFromAuthorizationHeader(c.req.header("authorization"));
    const body = await readJson<{ signature?: string; lease?: string }>(c);
    if (typeof body.signature !== "string" || body.signature === "") {
      throw new RejectedTransaction("signature is required", "malformed-body");
    }
    if (typeof body.lease !== "string" || !isAddress(body.lease)) {
      throw new RejectedTransaction("lease must be the lease account's address", "malformed-body");
    }
    const auditor = services.auditor();
    const rpc = services.client().rpc;

    let lease: DecodedLease;
    try {
      lease = await fetchLease(rpc, body.lease as Address, RELSTATE_PROGRAM as Address);
    } catch (error) {
      if (error instanceof LeaseNotFound) return c.json({ error: `no lease ${body.lease}`, code: "lease-unknown" }, 404);
      throw error;
    }
    if (session.wallet !== lease.tenant && session.wallet !== lease.landlord) {
      // Same shape as the unknown-lease answer on purpose: the amount is private, and so is who
      // the parties are to someone who is neither.
      return c.json({ error: `no lease ${body.lease}`, code: "lease-unknown" }, 404);
    }

    const check = await verifyRentPayment(rpc, body.signature as Signature, {
      relstateProgram: RELSTATE_PROGRAM as Address,
      expectedAmount: lease.rentAmount,
      auditorSecret: auditor.keys.elgamal.secret(),
      // Authorisation above is per LEASE; decryption is per TRANSACTION. Without this the caller is
      // cleared for one lease and handed the plaintext of any payment on the platform. A mismatch is
      // refused before anything is decrypted, and answers exactly like an unknown lease.
      expectedLease: body.lease as Address,
    });
    if (check.leaseMismatch) return c.json({ error: `no lease ${body.lease}`, code: "lease-unknown" }, 404);
    return c.json({
      ok: check.ok,
      lease: body.lease,
      signature: body.signature,
      expectedAmount: check.expectedAmount.toString(),
      settledAmount: check.settledAmount?.toString() ?? null,
      reason: check.reason ?? null,
      mint: lease.mint,
      paidCount: lease.paidCount,
      transfer: check.transfer === undefined ? null : { instructionIndex: check.transfer.instructionIndex, mint: check.transfer.mint },
    });
  });

  app.get("/api/treasury/invariant", async (c) => {
    const treasury = await services.treasury();
    return c.json(asInvariantView(await treasury.invariant()));
  });

  // Operator routes. In the real flow the on-ramp webhook drives these
  // (workstream C); they are here so the treasury is exercisable on stage and in
  // the scripted devnet run.
  app.post("/api/treasury/credit-reserve", async (c) => {
    treasuryLimit(`a:${clientIp(c)}`);
    assertAdmin(c.req.header("authorization"));
    const body = await readJson<{ amount?: string; ref?: string }>(c);
    const treasury = await services.treasury();
    if (treasury.mode === "live") {
      throw new RejectedTransaction("in live mode the reserve moves when real USDC arrives; nothing to credit", "live-mode");
    }
    treasury.creditReserve(parseAmount(body.amount), body.ref ?? "admin");
    return c.json(asInvariantView(await treasury.invariant()));
  });

  app.post("/api/treasury/wrap", async (c) => {
    treasuryLimit(`a:${clientIp(c)}`);
    assertAdmin(c.req.header("authorization"));
    const body = await readJson<{ wallet?: string; amount?: string; creditReserve?: boolean }>(c);
    if (typeof body.wallet !== "string" || body.wallet === "") {
      throw new RejectedTransaction("wallet is required", "malformed-body");
    }
    // Validate here rather than letting an invalid base58 string surface as a
    // PDA-derivation failure several calls deep.
    if (!isAddress(body.wallet)) {
      throw new RejectedTransaction(`wallet is not a valid address: ${body.wallet}`, "malformed-body");
    }
    const amount = parseAmount(body.amount);
    const treasury = await services.treasury();
    if (body.creditReserve === true) {
      if (treasury.mode === "live") {
        throw new RejectedTransaction("creditReserve is a mock-mode convenience only", "live-mode");
      }
      treasury.creditReserve(amount, "wrap-convenience");
    }
    const result = await treasury.wrap({ wallet: body.wallet, amount });
    return c.json({ token: result.token, signatures: result.signatures, invariant: asInvariantView(result.invariantAfter) });
  });

  // --- Fiat in and out (workstream E, docs/contracts/stripe.md) ---------------
  //
  // The security property worth stating once: of everything below, only
  // `POST /api/webhooks/stripe` credits anything, and it believes only what the
  // provider signed. The checkout route can price a top-up and nothing more; the
  // browser's return from the hosted page is a redirect the user controls, so it
  // is treated as a hint to re-read the balance.

  /** What the top-up screen needs to render itself, without hardcoding the demo rate. */
  app.get("/api/onramp/config", (c) => {
    const onramp = services.onramp();
    return c.json({
      provider: onramp.provider,
      simulated: onramp.provider === "mock",
      plnPerUsdc: formatRate(onramp.rateScaled),
      minPln: formatPln(parsePln(env.onramp.minPln, "ONRAMP_MIN_PLN")),
      maxPln: formatPln(parsePln(env.onramp.maxPln, "ONRAMP_MAX_PLN")),
      maxUsdcPerWalletPerDay: formatUsdc(onramp.cap),
    });
  });

  app.post("/api/onramp/checkout", async (c) => {
    const session = sessionFromAuthorizationHeader(c.req.header("authorization"));
    const body = await readJson<{ amountPln?: string | number; depositHoldbackUsdc?: string | number }>(c);
    if (body.amountPln === undefined) throw new RejectedTransaction("amountPln is required", "malformed-body");
    let amountPln: bigint;
    let holdback: bigint;
    try {
      amountPln = parsePln(body.amountPln);
      holdback = body.depositHoldbackUsdc === undefined ? 0n : parseUsdc(body.depositHoldbackUsdc, "depositHoldbackUsdc");
    } catch (error) {
      throw new RejectedTransaction(error instanceof Error ? error.message : String(error), "malformed-body");
    }
    // The wallet is the session's, never the body's: it is what the per-wallet
    // cap is keyed on and what the provider metadata will name as the recipient.
    const result = await services.onramp().checkout({ wallet: session.wallet, amountPln, holdbackUsdc: holdback });
    return c.json(result);
  });

  /**
   * Polled by the app after the hosted page sends the user back, because the
   * redirect proves nothing: the webhook may land before or after it.
   */
  app.get("/api/onramp/status", (c) => {
    const session = sessionFromAuthorizationHeader(c.req.header("authorization"));
    const id = c.req.query("intent") ?? "";
    if (id === "") throw new RejectedTransaction("intent is required", "malformed-body");
    const onramp = services.onramp();
    const intent = onramp.intent(id);
    // Do not confirm whether an intent exists for someone else's wallet.
    if (intent === undefined || intent.wallet !== session.wallet) {
      return c.json({ error: `no top-up ${id} for this wallet`, code: "intent-unknown" }, 404);
    }
    const credit = onramp.creditForIntent(id);
    return c.json({
      intent: id,
      wallet: intent.wallet,
      amountPln: formatPln(intent.plnMinor),
      amountUsdc: formatUsdc(intent.amountUsdc),
      plnPerUsdc: formatRate(intent.rateScaled),
      state: credit === undefined ? "pending" : credit.status,
      credit: credit ?? null,
      remainingToday: formatUsdc(onramp.remainingToday(session.wallet)),
    });
  });

  /**
   * The one trusted trigger. Deliberately unauthenticated and deliberately not
   * reading the parsed body: the signature covers the exact bytes received, so
   * re-serialising the JSON would break verification.
   *
   * In mock mode the same route takes the mock page's `{ intent }` confirmation,
   * so the demo and the real flow differ only in which provider verifies the
   * payload — not in what happens afterwards.
   */
  app.post("/api/webhooks/stripe", async (c) => {
    const raw = await c.req.text();
    const headers = { "stripe-signature": c.req.header("stripe-signature") ?? "" };
    const { credit, replay } = await services.onramp().handleWebhook(headers, raw);
    // 200 even for a rejected credit: the provider has done its part and
    // retrying would not change the outcome. The record says what happened.
    return c.json({ received: true, replay, credit }, 200);
  });

  if (env.onramp.provider === "mock") {
    /** The no-secrets stand-in for Stripe's hosted page. Mock mode only. */
    app.get("/mock/onramp", (c) => {
      const id = c.req.query("intent") ?? "";
      const intent = services.onramp().intent(id);
      if (intent === undefined) return c.text(`Unknown top-up intent ${id}. Start again from the app.`, 404);
      return c.html(mockCheckoutPage(intent, safeReturnBase(c.req.query("back"))));
    });
  }

  /** Fiat out: a mocked payout. Labelled `simulated` in the response and in the UI. */
  app.post("/api/offramp/payout", async (c) => {
    const session = sessionFromAuthorizationHeader(c.req.header("authorization"));
    const body = await readJson<{ amountUsdc?: string | number; method?: string; destination?: string }>(c);
    if (body.amountUsdc === undefined) throw new RejectedTransaction("amountUsdc is required", "malformed-body");
    let amountUsdc: bigint;
    try {
      amountUsdc = parseUsdc(body.amountUsdc);
    } catch (error) {
      throw new RejectedTransaction(error instanceof Error ? error.message : String(error), "malformed-body");
    }
    const receipt = await services.offramp().payout({
      wallet: session.wallet,
      amountUsdc,
      method: typeof body.method === "string" && body.method !== "" ? body.method.slice(0, 32) : undefined,
      destination: typeof body.destination === "string" ? body.destination : null,
    });
    return c.json(receipt);
  });

  app.get("/api/offramp/history", (c) => {
    const session = sessionFromAuthorizationHeader(c.req.header("authorization"));
    const offramp = services.offramp();
    return c.json({
      simulated: true,
      plnPerUsdc: formatRate(offramp.rateScaled),
      remainingToday: formatUsdc(offramp.remainingToday(session.wallet)),
      receipts: offramp.history(session.wallet),
    });
  });

  // --- Identity (workstream D, docs/contracts/attestation.md) ------------------
  //
  // The same shape as the fiat rail above, for the same reason: of everything here, only
  // `POST /api/webhooks/kyc` decides anything, and it believes only what the provider signed. The
  // browser can ask for a verification link and read a status; it cannot say it passed.

  /** Starts a verification for the session's wallet and returns the page to open. */
  app.post("/api/kyc/start", async (c) => {
    const session = sessionFromAuthorizationHeader(c.req.header("authorization"));
    // The wallet is the session's, never the body's: it is what the webhook will attest.
    return c.json(await services.kyc().start({ wallet: session.wallet }));
  });

  /** Reads the on-chain attestation for the session's wallet, plus whether the gate is on. */
  app.get("/api/kyc/status", async (c) => {
    const session = sessionFromAuthorizationHeader(c.req.header("authorization"));
    return c.json(await services.kyc().status(session.wallet));
  });

  /**
   * The one trusted trigger. Deliberately unauthenticated and deliberately not reading the parsed
   * body: Sumsub's digest covers the exact bytes received, so re-serialising the JSON would break
   * verification.
   *
   * An event we do not act on (`applicantCreated`, `applicantPending`, a non-final review) answers
   * 200 rather than 400, because the vendor would otherwise retry it forever — unlike a failed
   * signature check, which is a 400 and stays one. A failed *chain write* is not recorded at all,
   * so a retried delivery tries again (see `handleWebhook`).
   *
   * In mock mode the same route takes the mock page's `{ session, decision }`, so the demo and the
   * real flow differ only in which provider verifies the payload.
   */
  app.post("/api/webhooks/kyc", async (c) => {
    const raw = await c.req.text();
    const headers = {
      "x-payload-digest": c.req.header("x-payload-digest") ?? "",
      "x-payload-digest-alg": c.req.header("x-payload-digest-alg") ?? "",
    };
    try {
      const { record, replay } = await services.kyc().handleWebhook(headers, raw);
      return c.json({ received: true, replay, record }, 200);
    } catch (error) {
      if (error instanceof WebhookError && error.code === "event-ignored") {
        return c.json({ received: true, ignored: error.message, code: error.code }, 200);
      }
      throw error;
    }
  });

  if (env.kyc.provider === "mock") {
    /** The no-secrets stand-in for Sumsub's hosted check. Mock mode only. */
    app.get("/mock/kyc", (c) => {
      const id = c.req.query("session") ?? "";
      const session = services.kyc().session(id);
      if (session === undefined) return c.text(`Unknown verification session ${id}. Start again from the app.`, 404);
      return c.html(mockVerificationPage(session, safeReturnBase(c.req.query("back"), env.appUrl, "/#/app?tab=identity&kyc=")));
    });
  }

  // --- Appraisers (D2, docs/contracts/dispute-mediation.md §3, §10) -------------

  /**
   * The human-readable directory the chain deliberately does not hold. Public: names are fictional,
   * wallets are public keys. `nameHash` is what `Appraiser.name_hash` must equal, so anyone can check
   * the directory against the registry. Empty until APPRAISERS is configured.
   */
  // One registry read per entry is cheap but not free, so the answer is memoised for a few seconds
  // per process and the route shares the per-IP limiter the unauthenticated login routes use.
  const DIRECTORY_TTL_MS = 5000;
  let directoryMemo: { at: number; body: unknown } | undefined;
  app.get("/api/appraisers", async (c) => {
    limit(`d:${clientIp(c)}`);
    if (directoryMemo !== undefined && Date.now() - directoryMemo.at < DIRECTORY_TTL_MS) return c.json(directoryMemo.body);
    // In live mode the registry is the truth for fee/active/default: the program applies ITS fee, so
    // a directory that disagrees would show a verdict preview the chain will not honour. Best effort
    // with a short timeout (a slow RPC must not take the directory down); drift is flagged, not hidden.
    const onChain = async (wallet: Address) => {
      if (env.mode !== "live") return undefined;
      try {
        return await Promise.race([
          fetchAppraiser(services.client().rpc, wallet),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3000)),
        ]);
      } catch {
        return undefined;
      }
    };
    const appraisers = await Promise.all(
      services.appraisers().map(async (a) => {
        const record = await onChain(a.wallet);
        const fee = record ? record.fee : a.fee;
        return {
          name: a.name,
          wallet: a.wallet,
          fee: fee.toString(),
          feeSource: record ? "chain" : "directory",
          isDefault: record ? record.isDefault : a.isDefault,
          active: record ? record.active : null,
          registered: record === undefined ? null : record !== null,
          // The directory and the registry disagree: the setup script cannot edit a fee, so say so.
          drift: record ? record.fee !== a.fee || record.nameHash !== hex(appraiserNameHash(a.name)) || record.isDefault !== a.isDefault : false,
          nameHash: hex(appraiserNameHash(a.name)),
        };
      }),
    );
    directoryMemo = { at: Date.now(), body: { appraisers } };
    return c.json(directoryMemo.body);
  });

  /**
   * Demo appraiser console: signs a verdict with a configured appraiser key. Operator-only (its own
   * VERDICT_CONSOLE_TOKEN, never ADMIN_TOKEN) because the key decides a deposit. The route never takes a key or a signer from the body:
   * the appraiser is whoever the chain says is bound, and the backend must hold that key or it refuses.
   * `dryRun: true` returns what the verdict would pay and sends nothing.
   */
  app.post("/api/admin/appraiser/verdict", async (c) => {
    treasuryLimit(`a:${clientIp(c)}`);
    assertVerdictConsole(c.req.header("authorization"));
    const body = await readJson<{ lease?: unknown; deduction?: unknown; dryRun?: unknown }>(c);
    if (typeof body.lease !== "string" || !isAddress(body.lease)) {
      throw new RejectedTransaction("lease must be the lease account's address", "malformed-body");
    }
    const deduction = parseDeduction(body.deduction);
    const dryRun = parseOptionalBoolean(body.dryRun, "dryRun");
    // Any key the body carries beyond these is a typo for a flag we would silently ignore (a verdict
    // that goes live when the operator meant a preview), so unknown keys are refused too.
    for (const key of Object.keys(body)) {
      if (key !== "lease" && key !== "deduction" && key !== "dryRun") throw new RejectedTransaction(`unknown field ${key}`, "malformed-body");
    }
    const allowed = env.appraisers.consoleLeases.split(",").map((l) => l.trim()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(body.lease)) {
      throw new RejectedTransaction("this lease is not on VERDICT_CONSOLE_LEASES", "lease-not-allowed");
    }
    // Who asked, for which lease and amount. Never a token or key.
    console.log(`verdict console: ${dryRun ? "dry run" : "SUBMIT"} lease=${body.lease} deduction=${deduction} ip=${clientIp(c)}`);
    const chain = await services.appraiserChain();
    const input = { lease: body.lease as Address, deduction };
    const view = (plan: Awaited<ReturnType<typeof chain.plan>>) => ({
      lease: plan.lease,
      appraiser: plan.appraiser,
      deduction: plan.deduction.toString(),
      deposit: plan.deposit.toString(),
      toTenant: plan.split.toTenant.toString(),
      toLandlord: plan.split.toLandlord.toString(),
      feePaid: plan.split.feePaid.toString(),
      appraiserAta: plan.appraiserAta,
      appraiserAtaExists: plan.appraiserAtaExists,
    });
    if (dryRun) return c.json({ dryRun: true, ...view(await chain.plan(input)) });
    const result = await chain.submit(input);
    return c.json({ dryRun: false, signatures: result.signatures, ...view(result.plan) });
  });

  app.notFound((c) => c.json({ error: "not found", code: "not-found" }, 404));
  return app;
}

export type App = ReturnType<typeof createApp>;
