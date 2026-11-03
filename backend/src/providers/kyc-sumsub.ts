// Real KYC: Sumsub (docs/contracts/attestation.md, "Sumsub mapping").
//
// Written against Sumsub's documented API and webhook scheme, and **not exercised against the
// live service**: this demo has no Sumsub account, so there are no keys to run it with. That is
// the reason the verifier below is a pure function with tests of its own — the part that must be
// right before the first real webhook ever arrives is the part that decides whether to believe
// it, and that part can be tested with a known secret and a known body.
//
// Plain REST over `fetch`, like stripe.ts: two endpoints and two HMACs.
//
// Two different secrets, which is easy to confuse and fatal to mix up:
//
//   * `SUMSUB_SECRET_KEY` signs *our outgoing* API requests (`X-App-Access-Sig`);
//   * `SUMSUB_WEBHOOK_SECRET` is what *their incoming* webhooks are signed with
//     (`X-Payload-Digest`). It is set separately in the Sumsub dashboard.
//
// The only trusted trigger is the signed webhook. Nothing the browser says about its own
// verification result is believed — it never even reaches this file.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Provider } from "../contracts.ts";
import { retryingFetch } from "../rpc.ts";
import { WebhookError } from "./stripe.ts";
import type { KycProviderEvent } from "./kyc.ts";

export { WebhookError };

/** Raised when a Sumsub API call itself fails, so a route can report it without echoing a key. */
export class SumsubApiError extends Error {
  readonly status: number;
  readonly sumsubCode: string | undefined;
  constructor(message: string, status: number, sumsubCode?: string) {
    super(message);
    this.status = status;
    this.sumsubCode = sumsubCode;
  }
}

export type SumsubConfig = {
  appToken: string;
  /** Signs outgoing API requests. */
  secretKey: string;
  /** Verifies incoming webhooks. A different secret from `secretKey`. */
  webhookSecret: string;
  apiBase: string;
  /** The verification level configured in the Sumsub dashboard, e.g. `basic-kyc-level`. */
  levelName: string;
  /** How long a generated verification link stays usable. */
  linkTtlSeconds: number;
  /**
   * Pins the webhook digest algorithm to one of the three Sumsub offers. Empty accepts whichever
   * the `X-Payload-Digest-Alg` header names, which is Sumsub's own contract — every option is an
   * HMAC under the same secret, so the choice is not an attacker's to exploit, but a deployment
   * that knows what it configured may as well say so.
   */
  digestAlg: string;
  /** Events older (or newer) than this, by their own `createdAtMs`, are refused. */
  maxEventAgeSeconds: number;
};

/** The three schemes Sumsub documents for `X-Payload-Digest`. */
const DIGEST_ALGORITHMS: Record<string, "sha1" | "sha256" | "sha512"> = {
  HMAC_SHA1_HEX: "sha1",
  HMAC_SHA256_HEX: "sha256",
  HMAC_SHA512_HEX: "sha512",
};

export const DEFAULT_DIGEST_ALG = "HMAC_SHA256_HEX";
export const DEFAULT_MAX_EVENT_AGE_SECONDS = 600;

/**
 * Sumsub's `createdAtMs` is a UTC wall-clock string like "2020-02-21 13:23:19.321" (it is not
 * epoch milliseconds despite the name); an epoch number or ISO string is accepted as well.
 * Returns epoch milliseconds, or null when it cannot be read — which callers treat as stale.
 */
export function parseCreatedAtMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text) ? `${text.replace(" ", "T")}Z` : text;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

/** The slice of an `applicantReviewed` payload this backend reads. */
export type SumsubPayload = {
  applicantId?: string;
  inspectionId?: string;
  correlationId?: string;
  externalUserId?: string;
  levelName?: string;
  type?: string;
  reviewStatus?: string;
  reviewResult?: {
    reviewAnswer?: string;
    reviewRejectType?: string;
    rejectLabels?: string[];
  };
  createdAtMs?: string;
};

/**
 * Verifies `X-Payload-Digest` against the raw body and returns the parsed payload.
 *
 * Four ways to fail, each of which must reject rather than fall through:
 *
 *   * no webhook secret configured — refuse to trust anything, rather than "verify" with "";
 *   * a missing or malformed digest header;
 *   * an algorithm we do not implement, or one the deployment has pinned away from;
 *   * a digest that does not match the body.
 *
 * The comparison is constant-time, and the body must be the exact bytes received: re-serialising
 * the JSON changes the hash, which is why the route reads `c.req.text()` and not `c.req.json()`.
 *
 * Unlike Stripe's scheme there is no timestamp in the signature, so a captured delivery can be
 * replayed forever. Replay protection is therefore not cryptographic here — it is the idempotency
 * key in kyc.ts: one vendor event id attests exactly once.
 */
export function verifySumsubSignature(
  rawBody: string,
  headers: Record<string, string>,
  secret: string,
  { digestAlg = "", maxAgeSeconds = DEFAULT_MAX_EVENT_AGE_SECONDS, now = Date.now() }: { digestAlg?: string; maxAgeSeconds?: number; now?: number } = {},
): SumsubPayload {
  if (secret === "") throw new WebhookError("SUMSUB_WEBHOOK_SECRET is not configured; refusing to trust the webhook", "webhook-not-configured");

  const digest = (headers["x-payload-digest"] ?? "").trim();
  if (digest === "") throw new WebhookError("missing X-Payload-Digest header", "signature-missing");
  if (!/^[0-9a-f]+$/i.test(digest)) throw new WebhookError("X-Payload-Digest is not hex", "signature-malformed");

  const named = (headers["x-payload-digest-alg"] ?? "").trim().toUpperCase() || DEFAULT_DIGEST_ALG;
  if (digestAlg !== "" && named !== digestAlg.toUpperCase()) {
    throw new WebhookError(`webhook digest algorithm ${named} is not the configured ${digestAlg}`, "signature-alg-unexpected");
  }
  const algorithm = DIGEST_ALGORITHMS[named];
  if (algorithm === undefined) throw new WebhookError(`unsupported webhook digest algorithm ${named}`, "signature-alg-unsupported");

  const expected = createHmac(algorithm, secret).update(rawBody, "utf8").digest();
  const given = Buffer.from(digest, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new WebhookError("X-Payload-Digest does not match the request body", "signature-invalid");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new WebhookError("webhook body is not JSON", "body-malformed");
  }
  const payload = parsed as SumsubPayload;
  if (typeof payload?.type !== "string") throw new WebhookError("webhook body is not a Sumsub event", "body-malformed");

  // Freshness, after the signature so an attacker cannot probe the window without the secret. A
  // missing or unreadable timestamp is stale, not "unknown": failing open here is exactly the
  // replay this exists to stop.
  const createdAt = parseCreatedAtMs(payload.createdAtMs);
  if (createdAt === null) throw new WebhookError("webhook has no readable createdAtMs; refusing it as unverifiably old", "event-stale");
  const ageSeconds = Math.abs(now - createdAt) / 1000;
  if (ageSeconds > maxAgeSeconds) {
    throw new WebhookError(`webhook is ${Math.round(ageSeconds)}s away from now, outside the ${maxAgeSeconds}s window`, "event-stale");
  }
  return payload;
}

/**
 * The idempotency key for a delivery.
 *
 * Sumsub's payload has no single "event id" field that is documented as unique per event, so the
 * key is `correlationId` when present — which is what Sumsub correlates a delivery by — and
 * otherwise the applicant, the answer and the event timestamp, which together identify the same
 * review outcome across retries. Getting this wrong costs a duplicate `attest` of the same facts
 * (harmless, idempotent on chain) rather than a wrong attestation, but a stable key keeps the
 * audit trail honest.
 */
export function eventRef(payload: SumsubPayload): string {
  const answer = payload.reviewResult?.reviewAnswer ?? "?";
  // The answer is part of the key even with a correlationId: if Sumsub reuses one id for a GREEN
  // and a later RED, the RED must not be swallowed as a replay of the GREEN and skip the revoke.
  if (typeof payload.correlationId === "string" && payload.correlationId !== "") return `sumsub-${payload.correlationId}-${answer}`;
  return `sumsub-${payload.type ?? "?"}-${payload.applicantId ?? "?"}-${answer}-${payload.createdAtMs ?? "?"}`;
}

/**
 * Maps a verified payload onto the internal event.
 *
 * Only `applicantReviewed` with a final answer says anything about identity. Everything else —
 * `applicantCreated`, `applicantPending`, `applicantOnHold`, the reviewer re-opening a case — is
 * ignored by code, which is a 200 and no chain write (see the route). `GREEN` attests, `RED`
 * revokes; a `RETRY` red is still a red, because until the applicant passes again they are not
 * verified, and `revoke` on a wallet that never had an attestation is a no-op in the service.
 */
export function payloadToProviderEvent(payload: SumsubPayload): KycProviderEvent {
  if (payload.type !== "applicantReviewed") {
    throw new WebhookError(`ignoring event type ${payload.type}`, "event-ignored");
  }
  const applicantId = payload.applicantId ?? "";
  if (applicantId === "") throw new WebhookError("applicantReviewed carries no applicantId", "applicant-missing");
  // The wallet, bound when the applicant was created. Without it there is nobody to attest, and
  // guessing is not an option: this is the only thing tying a document check to an address.
  const wallet = payload.externalUserId ?? "";
  if (wallet === "") throw new WebhookError(`applicant ${applicantId} carries no externalUserId`, "wallet-missing");

  const answer = (payload.reviewResult?.reviewAnswer ?? "").toUpperCase();
  if (answer !== "GREEN" && answer !== "RED") {
    throw new WebhookError(`applicant ${applicantId} has no final review answer (${answer || "none"})`, "event-ignored");
  }
  return {
    kind: answer === "GREEN" ? "kyc.approved" : "kyc.rejected",
    wallet,
    ref: eventRef(payload),
    applicantId,
    levelName: payload.levelName,
    reason: answer === "RED" ? (payload.reviewResult?.reviewRejectType ?? "RED") : undefined,
  };
}

type Fetch = typeof fetch;

export type SumsubKyc = Provider & {
  /** Verified payload mapped onto the internal event; `webhook` is this plus the interface's shape. */
  parse(headers: Record<string, string>, rawBody: string): KycProviderEvent;
};

/**
 * Signs an outgoing API request the way Sumsub's App Token scheme requires:
 * `HMAC_SHA256(secretKey, ts + METHOD + path?query + body)`, hex, alongside the token and the
 * timestamp it covers.
 */
export function signRequest(
  config: Pick<SumsubConfig, "appToken" | "secretKey">,
  method: string,
  pathWithQuery: string,
  body: string,
  now = Date.now(),
): Record<string, string> {
  const ts = Math.floor(now / 1000).toString();
  const signature = createHmac("sha256", config.secretKey)
    .update(ts + method.toUpperCase() + pathWithQuery + body)
    .digest("hex");
  return {
    "x-app-token": config.appToken,
    "x-app-access-ts": ts,
    "x-app-access-sig": signature,
  };
}

export function createSumsubKyc(config: SumsubConfig, deps: { fetch?: Fetch; log?: (...args: unknown[]) => void; now?: () => number } = {}): SumsubKyc {
  const doFetch = deps.fetch ?? ((input, init) => retryingFetch(input as string, init as RequestInit));
  const log = deps.log ?? (() => {});

  async function call(method: "GET" | "POST", pathWithQuery: string, body = ""): Promise<Record<string, unknown>> {
    const response = await doFetch(`${config.apiBase}${pathWithQuery}`, {
      method,
      headers: {
        ...signRequest(config, method, pathWithQuery, body),
        accept: "application/json",
        ...(body === "" ? {} : { "content-type": "application/json" }),
      },
      ...(body === "" ? {} : { body }),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* a non-JSON body from Sumsub is an outage; the status carries the story */
    }
    if (!response.ok) {
      const description = typeof parsed.description === "string" ? parsed.description : `Sumsub ${pathWithQuery} failed (${response.status})`;
      // Never echo the request: the signing headers and this message share a log.
      throw new SumsubApiError(description, response.status, typeof parsed.code === "string" ? parsed.code : undefined);
    }
    return parsed;
  }

  return {
    /**
     * Returns a hosted WebSDK link for this wallet.
     *
     * `externalUserId` is the wallet address, set here and nowhere else: it is what the webhook
     * reads back to decide whose attestation to write, so it must come from our session rather
     * than from anything the browser sends later.
     */
    async start(wallet: string) {
      const query = new URLSearchParams({ externalUserId: wallet, ttlInSecs: String(config.linkTtlSeconds) });
      const path = `/resources/sdkIntegrations/levels/${encodeURIComponent(config.levelName)}/websdkLink?${query.toString()}`;
      const body = await call("POST", path, "{}");
      const url = body.url;
      if (typeof url !== "string" || url === "") throw new SumsubApiError("Sumsub returned no verification URL", 502);
      log(`kyc: sumsub link issued for ${wallet} at level ${config.levelName}`);
      return { url };
    },

    async webhook(headers: Record<string, string>, rawBody: string) {
      return this.parse(headers, rawBody);
    },

    parse(headers: Record<string, string>, rawBody: string) {
      const payload = verifySumsubSignature(rawBody, headers, config.webhookSecret, {
        digestAlg: config.digestAlg,
        maxAgeSeconds: config.maxEventAgeSeconds,
        now: (deps.now ?? Date.now)(),
      });
      return payloadToProviderEvent(payload);
    },
  };
}
