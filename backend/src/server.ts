// Phase 1, step 9: the backend skeleton. Hono, one health route, the hardened
// sponsor endpoint, and the treasury operations. No providers yet — workstream C
// adds the webhook routes on top of this.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { AuthError, assertAdmin, createSessionToken, sessionFromAuthorizationHeader } from "./auth.ts";
import type { HealthResponse, SponsorRequest, TreasuryInvariantView } from "./contracts.ts";
import { env, redactedRpcUrl } from "./env.ts";
import { LimitError } from "./limits.ts";
import { ServiceUnavailable, createServices, type Services } from "./services.ts";
import { InvariantViolation, reportForLog, type InvariantReport } from "./treasury.ts";
import { RejectedTransaction } from "./txinspect.ts";

const asInvariantView = (report: InvariantReport): TreasuryInvariantView => reportForLog(report);

/** Maps a thrown error to a status and a message safe to return to a caller. */
function problem(error: unknown): { status: 400 | 401 | 409 | 429 | 500 | 503; body: Record<string, unknown> } {
  if (error instanceof RejectedTransaction) return { status: 400, body: { error: error.message, code: error.code } };
  if (error instanceof AuthError) return { status: 401, body: { error: error.message, code: "unauthorized" } };
  if (error instanceof LimitError) return { status: 429, body: { error: error.message, code: "rate-limited", scope: error.scope } };
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
  // Anything else is a bug or an upstream failure: log it, return nothing specific.
  console.error("unhandled error:", error);
  return { status: 500, body: { error: "internal error", code: "internal" } };
}

async function readJson<T>(c: { req: { json(): Promise<unknown> } }): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new RejectedTransaction("body must be JSON", "malformed-body");
  }
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

export function createApp(services: Services = createServices()) {
  const app = new Hono();
  app.use("*", cors({ origin: env.corsOrigin, allowHeaders: ["content-type", "authorization"], allowMethods: ["GET", "POST", "OPTIONS"] }));

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
      const { wallet } = await readJson<{ wallet?: string }>(c);
      if (typeof wallet !== "string" || wallet.trim() === "") {
        throw new RejectedTransaction("wallet is required", "malformed-body");
      }
      const { token, expiresAt } = createSessionToken(wallet);
      return c.json({ token, wallet, expiresAt });
    });
  }

  app.post("/api/sponsor", async (c) => {
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
    sessionFromAuthorizationHeader(c.req.header("authorization"));
    const { txBase64 } = await readJson<{ txBase64?: string }>(c);
    if (typeof txBase64 !== "string" || txBase64 === "") {
      throw new RejectedTransaction("txBase64 is required", "malformed-body");
    }
    const treasury = await services.treasury();
    return c.json(await treasury.sponsorConfidentialAccountSetup({ txBase64 }));
  });

  app.get("/api/treasury/invariant", async (c) => {
    const treasury = await services.treasury();
    return c.json(asInvariantView(await treasury.invariant()));
  });

  // Operator routes. In the real flow the on-ramp webhook drives these
  // (workstream C); they are here so the treasury is exercisable on stage and in
  // the scripted devnet run.
  app.post("/api/treasury/credit-reserve", async (c) => {
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
    assertAdmin(c.req.header("authorization"));
    const body = await readJson<{ wallet?: string; amount?: string; creditReserve?: boolean }>(c);
    if (typeof body.wallet !== "string" || body.wallet === "") {
      throw new RejectedTransaction("wallet is required", "malformed-body");
    }
    const amount = parseAmount(body.amount);
    const treasury = await services.treasury();
    if (body.creditReserve === true) {
      if (treasury.mode === "live") {
        throw new RejectedTransaction("creditReserve is a mock-mode convenience only", "live-mode");
      }
      treasury.creditReserve(amount, "wrap-convenience");
    }
    const result = await treasury.wrap({ wallet: body.wallet as Parameters<typeof treasury.wrap>[0]["wallet"], amount });
    return c.json({ token: result.token, signatures: result.signatures, invariant: asInvariantView(result.invariantAfter) });
  });

  app.notFound((c) => c.json({ error: "not found", code: "not-found" }, 404));
  return app;
}

export type App = ReturnType<typeof createApp>;
