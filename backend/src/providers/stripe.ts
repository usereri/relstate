// Fiat in: Stripe test mode (docs/contracts/stripe.md).
//
// Stands in for a production on-ramp (Ramp/Transak/MoneyGram), all of which
// settle on mainnet. Test mode only: no real money moves and the USDC behind the
// peg is devnet test USDC. Say that on stage.
//
// Plain REST over `fetch` rather than the `stripe` npm package: this uses two
// endpoints and one HMAC, and the package would be the backend's largest
// dependency by an order of magnitude. The retrying fetch from rpc.ts gives the
// same 429/5xx backoff the rest of the backend has.
//
// The only trusted trigger is the signed webhook. The browser's return from the
// hosted page is a redirect an attacker controls completely, so it never credits
// anything — it only tells the app to re-read its balance.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Provider, ProviderEvent } from "../contracts.ts";
import { retryingFetch } from "../rpc.ts";
import { formatPln, parseRate, plnToUsdc } from "./money.ts";

/** A webhook that failed verification, or an event we will not act on. Carries no secret. */
export class WebhookError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/** Raised when the vendor call itself failed, so the route can say so without echoing the key. */
export class StripeApiError extends Error {
  readonly status: number;
  readonly stripeCode: string | undefined;
  constructor(message: string, status: number, stripeCode?: string) {
    super(message);
    this.status = status;
    this.stripeCode = stripeCode;
  }
}

/**
 * Metadata we put on the Checkout Session and read back off the signed event.
 *
 * `wallet` is the whole point: it is set server-side from the session token at
 * checkout time, so the webhook learns who to credit from Stripe's signature
 * rather than from whoever posted to the endpoint. `plnPerUsdc` is pinned here
 * too, so a rate change between checkout and settlement cannot alter what a
 * paid session is worth.
 */
export type CheckoutMetadata = {
  wallet: string;
  plnPerUsdc: string;
  /** Base units to keep public for `fund_deposit` (docs/contracts/treasury.md). */
  holdback: string;
  intent: string;
};

export type StripeConfig = {
  secretKey: string;
  webhookSecret: string;
  apiBase: string;
  /** Checked against the event's timestamp; Stripe's own default is 300s. */
  toleranceSeconds: number;
  paymentMethods: string[];
  /** Fixed-point PLN per USDC, used only for an event whose metadata lost the rate. */
  plnPerUsdc: bigint;
};

type Fetch = typeof fetch;

/** Form-encodes the nested shape Stripe's API expects (`a[b][0]=x`). */
export function encodeForm(params: Record<string, string | number | undefined>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) body.set(key, String(value));
  }
  return body.toString();
}

/**
 * Verifies a `Stripe-Signature` header and returns the parsed event.
 *
 * Three separate failures, each of which must reject: a signature that does not
 * match the raw body (forgery), a timestamp outside the tolerance (a replay of a
 * genuinely signed body), and a body that is not a Stripe event at all. The
 * comparison is constant-time; the body must be the exact bytes received,
 * because re-serialising JSON changes the hash.
 */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  { toleranceSeconds = 300, now = Date.now() }: { toleranceSeconds?: number; now?: number } = {},
): StripeEvent {
  if (secret === "") throw new WebhookError("STRIPE_WEBHOOK_SECRET is not configured; refusing to trust the webhook", "webhook-not-configured");
  const header = (signatureHeader ?? "").trim();
  if (header === "") throw new WebhookError("missing Stripe-Signature header", "signature-missing");

  let timestamp: string | undefined;
  const candidates: Buffer[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value !== undefined) timestamp = value;
    // v0 is the test-mode scheme for the CLI's `--skip-verify`; only v1 is accepted.
    if (key === "v1" && value !== undefined && /^[0-9a-f]+$/i.test(value)) candidates.push(Buffer.from(value, "hex"));
  }
  if (timestamp === undefined || !/^\d+$/.test(timestamp)) throw new WebhookError("Stripe-Signature has no timestamp", "signature-malformed");
  if (candidates.length === 0) throw new WebhookError("Stripe-Signature has no v1 signature", "signature-malformed");

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  const matched = candidates.some((given) => given.length === expected.length && timingSafeEqual(given, expected));
  if (!matched) throw new WebhookError("Stripe-Signature does not match the request body", "signature-invalid");

  const ageSeconds = Math.abs(Math.floor(now / 1000) - Number(timestamp));
  if (ageSeconds > toleranceSeconds) {
    throw new WebhookError(`webhook timestamp is ${ageSeconds}s old, outside the ${toleranceSeconds}s tolerance`, "signature-expired");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new WebhookError("webhook body is not JSON", "body-malformed");
  }
  const event = parsed as StripeEvent;
  if (typeof event?.id !== "string" || typeof event?.type !== "string") {
    throw new WebhookError("webhook body is not a Stripe event", "body-malformed");
  }
  return event;
}

export type StripeEvent = {
  id: string;
  type: string;
  data?: { object?: Record<string, unknown> };
};

export type StripeCheckoutSession = {
  id: string;
  url?: string | null;
  amount_total?: number | null;
  currency?: string | null;
  payment_status?: string | null;
  metadata?: Record<string, string> | null;
};

/**
 * Turns a verified `checkout.session.completed` into a `ProviderEvent`.
 *
 * Everything that decides how much rUSDC is minted comes off the event: the
 * amount from `amount_total`, the recipient from `metadata.wallet`, the rate
 * from `metadata.plnPerUsdc`. The client never gets a say — it could only ever
 * have asked for a Checkout Session, which Stripe then priced and settled.
 */
export function eventToProviderEvent(event: StripeEvent, fallbackRate: bigint): ProviderEvent & { holdback: bigint; plnMinor: bigint } {
  if (event.type !== "checkout.session.completed") {
    throw new WebhookError(`ignoring event type ${event.type}`, "event-ignored");
  }
  const session = (event.data?.object ?? {}) as StripeCheckoutSession;
  if ((session.payment_status ?? "") !== "paid") {
    throw new WebhookError(`checkout session ${session.id ?? "?"} is ${session.payment_status ?? "unpaid"}, not paid`, "not-paid");
  }
  // A session in another currency would be priced against a PLN rate and mint
  // the wrong amount, so it is refused rather than converted.
  const currency = (session.currency ?? "").toLowerCase();
  if (currency !== "pln") {
    throw new WebhookError(`checkout session ${session.id ?? "?"} settled in ${currency || "an unknown currency"}, expected pln`, "wrong-currency");
  }
  const total = session.amount_total;
  if (typeof total !== "number" || !Number.isInteger(total) || total <= 0) {
    throw new WebhookError(`checkout session ${session.id ?? "?"} has no positive amount_total`, "amount-missing");
  }
  const wallet = session.metadata?.wallet ?? "";
  if (wallet === "") throw new WebhookError(`checkout session ${session.id ?? "?"} carries no metadata.wallet`, "wallet-missing");

  const rate = session.metadata?.plnPerUsdc === undefined ? fallbackRate : parseRate(session.metadata.plnPerUsdc, "metadata.plnPerUsdc");
  const plnMinor = BigInt(total);
  const holdbackText = session.metadata?.holdback ?? "0";
  if (!/^\d+$/.test(holdbackText)) throw new WebhookError(`checkout session ${session.id ?? "?"} has a malformed metadata.holdback`, "holdback-malformed");

  return {
    kind: "onramp.completed",
    wallet,
    // The Stripe event id, so a redelivery of the same event is the same ref.
    ref: event.id,
    amountUsdc: Number(plnToUsdc(plnMinor, rate)),
    holdback: BigInt(holdbackText),
    plnMinor,
  };
}

export type StripeOnramp = Provider & {
  /** Verified event plus the base-unit amounts the service needs. */
  parse(headers: Record<string, string>, rawBody: string): ProviderEvent & { holdback: bigint; plnMinor: bigint };
};

export function createStripeOnramp(config: StripeConfig, deps: { fetch?: Fetch; log?: (...args: unknown[]) => void } = {}): StripeOnramp {
  const doFetch = deps.fetch ?? ((input, init) => retryingFetch(input as string, init as RequestInit));
  const log = deps.log ?? (() => {});

  async function post(path: string, form: Record<string, string | number | undefined>, idempotencyKey: string): Promise<Record<string, unknown>> {
    const response = await doFetch(`${config.apiBase}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": idempotencyKey,
        "stripe-version": "2024-06-20",
      },
      body: encodeForm(form),
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* a non-JSON body from Stripe is an outage; the status carries the story */
    }
    if (!response.ok) {
      const error = (body.error ?? {}) as { message?: string; code?: string; param?: string };
      // Never include the request body in the message: it would echo nothing
      // secret today, but the Authorization header and this message share a log.
      throw new StripeApiError(error.message ?? `Stripe ${path} failed (${response.status})`, response.status, error.code ?? error.param);
    }
    return body;
  }

  return {
    /**
     * Creates a hosted Checkout Session in PLN. `opts` carries the priced amount
     * and the metadata; see `createOnramp` for where those come from.
     */
    async start(wallet: string, opts: Record<string, unknown> = {}) {
      const grosz = opts.grosz as bigint;
      const metadata = opts.metadata as CheckoutMetadata;
      const successUrl = String(opts.successUrl ?? "");
      const cancelUrl = String(opts.cancelUrl ?? "");

      const form = (methods: string[]): Record<string, string | number | undefined> => ({
        mode: "payment",
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: wallet.slice(0, 200),
        "metadata[wallet]": metadata.wallet,
        "metadata[plnPerUsdc]": metadata.plnPerUsdc,
        "metadata[holdback]": metadata.holdback,
        "metadata[intent]": metadata.intent,
        "line_items[0][quantity]": 1,
        "line_items[0][price_data][currency]": "pln",
        "line_items[0][price_data][unit_amount]": grosz.toString(),
        "line_items[0][price_data][product_data][name]": "Relstate top-up (Stripe test mode)",
        "line_items[0][price_data][product_data][description]": `${formatPln(grosz)} PLN of rUSDC on devnet — test mode, no real money`,
        ...Object.fromEntries(methods.map((method, index) => [`payment_method_types[${index}]`, method])),
      });

      let session: Record<string, unknown>;
      try {
        session = await post("/v1/checkout/sessions", form(config.paymentMethods), metadata.intent);
      } catch (error) {
        // BLIK needs a PLN-capable account with the method enabled. Rather than
        // failing a demo top-up over an account capability, drop back to card
        // and say so once.
        const extra = config.paymentMethods.filter((m) => m !== "card");
        if (error instanceof StripeApiError && extra.length > 0 && /payment_method_types|not activated|invalid|capabilit/i.test(error.message)) {
          log(`stripe: ${extra.join(", ")} rejected by this account (${error.message}); retrying with card only`);
          session = await post("/v1/checkout/sessions", form(["card"]), `${metadata.intent}-card`);
        } else {
          throw error;
        }
      }
      const url = session.url;
      if (typeof url !== "string" || url === "") throw new StripeApiError("Stripe returned a Checkout Session with no URL", 502);
      return { url };
    },

    async webhook(headers: Record<string, string>, rawBody: string): Promise<ProviderEvent> {
      return this.parse(headers, rawBody);
    },

    parse(headers: Record<string, string>, rawBody: string) {
      const event = verifyStripeSignature(rawBody, headers["stripe-signature"], config.webhookSecret, {
        toleranceSeconds: config.toleranceSeconds,
      });
      return eventToProviderEvent(event, config.plnPerUsdc);
    },
  };
}
