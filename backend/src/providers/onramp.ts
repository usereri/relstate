// The on-ramp service: what happens between "the tenant typed 400 PLN" and
// "there is rUSDC in their wallet". See docs/contracts/stripe.md.
//
// Trust model, which is the only interesting thing in this file:
//
//   * the browser can ask for a Checkout Session and nothing else;
//   * the amount credited comes from the signed provider event, never from a
//     request body — a redirect back from the hosted page credits nothing;
//   * one provider event credits exactly once, keyed on the vendor's event id,
//     because providers retry deliveries and Stripe explicitly may deliver the
//     same event twice;
//   * a per-wallet daily cap bounds the damage from a stolen session token.
//
// The mock provider goes through this same path: its "payment" resolves a
// server-side intent created under the session, so even the mock never takes an
// amount from the page that confirms it.
import { isAddress, type Address } from "@solana/kit";
import { randomUUID } from "node:crypto";
import type { Provider, ProviderEvent, TreasuryInvariantView } from "../contracts.ts";
import { confidentialMoveAmount, reportForLog, type Treasury } from "../treasury.ts";
import { RATE_DECIMALS, formatPln, formatScaled, formatUsdc, plnToUsdc, usdcToPln } from "./money.ts";
import { WebhookError, createStripeOnramp, type CheckoutMetadata, type StripeConfig } from "./stripe.ts";

export { WebhookError };

/** The slice of the treasury the on-ramp needs, so a test can fake it without an RPC. */
export type OnrampTreasury = Pick<Treasury, "mode" | "creditReserve" | "wrap" | "wrapAndMakeConfidential" | "invariant">;

/** A top-up the user asked for. Priced and stored server-side before the hosted page ever opens. */
export type OnrampIntent = {
  id: string;
  wallet: string;
  /** Grosz. */
  plnMinor: bigint;
  /** Base units. */
  amountUsdc: bigint;
  /** Base units kept public for `fund_deposit`. */
  holdback: bigint;
  rateScaled: bigint;
  provider: "mock" | "stripe";
  createdAt: number;
};

export type OnrampCredit = {
  /** The provider's event id: the idempotency key for the whole credit. */
  ref: string;
  intent: string | null;
  wallet: string;
  /** Base units. */
  amountUsdc: string;
  /** Grosz. */
  amountPln: string;
  publicHoldback: string;
  confidentialAmount: string;
  /** True while the confidential move still needs the wallet's own keys (the normal webhook path). */
  confidentialPending: boolean;
  status: "credited" | "rejected";
  reason?: string;
  signatures: string[];
  invariant?: TreasuryInvariantView;
  at: number;
};

export type CheckoutResult = {
  url: string;
  intent: string;
  provider: "mock" | "stripe";
  /** "400.00" */
  amountPln: string;
  /** "93.023255" */
  amountUsdc: string;
  plnPerUsdc: string;
  publicHoldback: string;
  /** True in mock mode: no money, no card, the checkout page confirms instantly. */
  simulated: boolean;
};

export class OnrampError extends Error {
  readonly code: string;
  readonly status: 400 | 429 | 502;
  constructor(message: string, code: string, status: 400 | 429 | 502 = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type OnrampConfig = {
  provider: "mock" | "stripe";
  /** Fixed-point PLN per USDC. */
  rateScaled: bigint;
  /** Grosz. */
  minPln: bigint;
  maxPln: bigint;
  /** Base units per wallet per rolling day. */
  maxUsdcPerWalletPerDay: bigint;
  /** Absolute base URL of this backend, for the mock checkout page. */
  backendUrl: string;
  /** Absolute base URL of the app, for the hosted page's return. */
  appUrl: string;
  /** Required when `provider` is `stripe`; `assertEnvConsistent` refuses the half-configured case. */
  stripe?: StripeConfig;
};

/** What a provider hands back here: `ProviderEvent` plus the parts only the fiat leg cares about. */
export type OnrampProviderEvent = ProviderEvent & { holdback?: bigint; plnMinor?: bigint };

export type OnrampDeps = {
  config: OnrampConfig;
  /** Resolved lazily: a fresh clone with no rUSDC mint can still serve a checkout. */
  treasury: () => Promise<OnrampTreasury>;
  provider?: Provider;
  /**
   * Test and scripted-devnet seam. When the owner's signer and confidential keys
   * are available the credit finishes the whole wrap including the confidential
   * move; in production nobody holds a user's key, so the webhook mints to the
   * public balance and the app completes `deposit` + `apply pending` over a
   * sponsored transaction (docs/contracts/treasury.md).
   */
  resolveOwner?: (wallet: string) => Promise<{
    owner: Parameters<Treasury["wrapAndMakeConfidential"]>[0]["owner"];
    keys: Parameters<Treasury["wrapAndMakeConfidential"]>[0]["keys"];
  } | null>;
  log?: (...args: unknown[]) => void;
  now?: () => number;
};

const DAY_MS = 86_400_000;

/** Rolling-window total per wallet, in base units. Same shape as limits.ts, different unit. */
export function createDailyCap(limit: bigint, windowMs = DAY_MS) {
  const byWallet = new Map<string, Array<{ at: number; amount: bigint }>>();
  const live = (wallet: string, now: number) => {
    const kept = (byWallet.get(wallet) ?? []).filter((e) => now - e.at <= windowMs);
    if (kept.length === 0) byWallet.delete(wallet);
    else byWallet.set(wallet, kept);
    return kept;
  };
  return {
    used: (wallet: string, now = Date.now()): bigint => live(wallet, now).reduce((n, e) => n + e.amount, 0n),
    remaining(wallet: string, now = Date.now()): bigint {
      const left = limit - this.used(wallet, now);
      return left < 0n ? 0n : left;
    },
    /** Throws `OnrampError` when `amount` would take the wallet past the cap. */
    check(wallet: string, amount: bigint, now = Date.now()): void {
      const used = this.used(wallet, now);
      if (used + amount > limit) {
        throw new OnrampError(
          `wallet has been credited ${formatUsdc(used)} rUSDC in the last 24h; ${formatUsdc(amount)} more would pass the ${formatUsdc(limit)} daily cap`,
          "wallet-cap",
          429,
        );
      }
    },
    record(wallet: string, amount: bigint, now = Date.now()): void {
      byWallet.set(wallet, [...live(wallet, now), { at: now, amount }]);
    },
    limit,
  };
}

/**
 * The no-secrets provider. `start` points at a page this backend serves; that
 * page posts the intent id back through the real webhook route, and the amount
 * is read from the stored intent rather than from the page's request.
 */
export function createMockOnramp(deps: { intent: (id: string) => OnrampIntent | undefined; backendUrl: string }): Provider {
  return {
    async start(_wallet: string, opts: Record<string, unknown> = {}) {
      const metadata = opts.metadata as CheckoutMetadata;
      const back = String(opts.returnBase ?? "");
      return { url: `${deps.backendUrl}/mock/onramp?intent=${encodeURIComponent(metadata.intent)}&back=${encodeURIComponent(back)}` };
    },
    async webhook(_headers: Record<string, string>, rawBody: string): Promise<ProviderEvent> {
      let body: { intent?: unknown };
      try {
        body = JSON.parse(rawBody) as { intent?: unknown };
      } catch {
        throw new WebhookError("mock webhook body is not JSON", "body-malformed");
      }
      if (typeof body.intent !== "string" || body.intent === "") {
        throw new WebhookError("mock webhook needs { intent }", "body-malformed");
      }
      const intent = deps.intent(body.intent);
      if (intent === undefined) throw new WebhookError(`unknown top-up intent ${body.intent}`, "intent-unknown");
      // `ref` is the intent id, so confirming the same mock checkout twice is
      // the same event twice — which is exactly what it should be.
      return { kind: "onramp.completed", wallet: intent.wallet, ref: `mock-${intent.id}`, amountUsdc: Number(intent.amountUsdc) };
    },
  };
}

export function createOnramp(deps: OnrampDeps) {
  const { config } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const cap = createDailyCap(config.maxUsdcPerWalletPerDay);

  const intents = new Map<string, OnrampIntent>();
  const credits = new Map<string, OnrampCredit>();
  const creditsByIntent = new Map<string, string>();
  /** In flight by ref: a provider that retries before we answer must not credit twice. */
  const inFlight = new Map<string, Promise<OnrampCredit>>();

  const provider: Provider =
    deps.provider ??
    (config.provider === "stripe" && config.stripe !== undefined
      ? createStripeOnramp(config.stripe, { log })
      : createMockOnramp({ intent: (id) => intents.get(id), backendUrl: config.backendUrl }));

  /**
   * Prices a top-up and hands back the hosted-page URL.
   *
   * `wallet` comes from the session token, never from the body: that is what
   * makes the per-wallet cap mean anything and what stops one user crediting
   * another. The amount is checked here only to fail fast and to keep the demo
   * honest — the webhook re-derives it from the provider event regardless.
   */
  async function checkout({ wallet, amountPln, holdbackUsdc = 0n }: { wallet: string; amountPln: bigint; holdbackUsdc?: bigint }): Promise<CheckoutResult> {
    if (!isAddress(wallet)) throw new OnrampError(`${wallet} is not a valid wallet address`, "malformed-wallet");
    if (amountPln < config.minPln || amountPln > config.maxPln) {
      throw new OnrampError(
        `top up between ${formatPln(config.minPln)} and ${formatPln(config.maxPln)} PLN (asked for ${formatPln(amountPln)})`,
        "amount-out-of-range",
      );
    }
    const amountUsdc = plnToUsdc(amountPln, config.rateScaled);
    if (amountUsdc <= 0n) throw new OnrampError(`${formatPln(amountPln)} PLN rounds to zero rUSDC at the demo rate`, "amount-too-small");
    if (holdbackUsdc > amountUsdc) {
      // confidentialMoveAmount would throw later with the same meaning; saying
      // it here keeps the mistake in front of the person who made it.
      throw new OnrampError(
        `the public holdback ${formatUsdc(holdbackUsdc)} exceeds the ${formatUsdc(amountUsdc)} rUSDC this top-up buys`,
        "holdback-too-large",
      );
    }
    cap.check(wallet, amountUsdc, now());

    const intent: OnrampIntent = {
      id: randomUUID(),
      wallet,
      plnMinor: amountPln,
      amountUsdc,
      holdback: holdbackUsdc,
      rateScaled: config.rateScaled,
      provider: config.provider,
      createdAt: now(),
    };
    const metadata: CheckoutMetadata = {
      wallet,
      plnPerUsdc: formatRate(config.rateScaled),
      holdback: holdbackUsdc.toString(),
      intent: intent.id,
    };
    // The app is a hash router, so the return path lives inside the fragment.
    const returnBase = `${config.appUrl}/#/app?tab=wallet&topup=`;
    const { url } = await provider.start(wallet, {
      grosz: amountPln,
      metadata,
      returnBase,
      successUrl: `${returnBase}done&intent=${intent.id}`,
      cancelUrl: `${returnBase}cancelled&intent=${intent.id}`,
    });
    if (url === undefined || url === "") throw new OnrampError("the on-ramp provider returned no checkout URL", "provider-no-url", 502);

    intents.set(intent.id, intent);
    log(`onramp: intent ${intent.id} for ${wallet}: ${formatPln(amountPln)} PLN -> ${formatUsdc(amountUsdc)} rUSDC (${config.provider})`);
    return {
      url,
      intent: intent.id,
      provider: config.provider,
      amountPln: formatPln(amountPln),
      amountUsdc: formatUsdc(amountUsdc),
      plnPerUsdc: formatRate(config.rateScaled),
      publicHoldback: formatUsdc(holdbackUsdc),
      simulated: config.provider === "mock",
    };
  }

  /**
   * The only trusted trigger. Verifies the provider's signature, then credits at
   * most once per event id.
   *
   * A duplicate delivery returns the first result verbatim rather than redoing
   * the mint; a delivery that arrives while the first is still running waits on
   * it, because the provider's retry timer does not care that we are mid-mint.
   */
  async function handleWebhook(headers: Record<string, string>, rawBody: string): Promise<{ credit: OnrampCredit; replay: boolean }> {
    const event: OnrampProviderEvent = await provider.webhook(headers, rawBody);
    if (event.kind !== "onramp.completed") throw new WebhookError(`ignoring ${event.kind}`, "event-ignored");
    if (event.ref === "") throw new WebhookError("provider event has no reference; cannot make the credit idempotent", "ref-missing");

    const existing = credits.get(event.ref);
    if (existing !== undefined) {
      log(`onramp: event ${event.ref} already ${existing.status}; not crediting again`);
      return { credit: existing, replay: true };
    }
    const running = inFlight.get(event.ref);
    if (running !== undefined) return { credit: await running, replay: true };

    const promise = creditEvent(event, rawBody).finally(() => inFlight.delete(event.ref));
    inFlight.set(event.ref, promise);
    return { credit: await promise, replay: false };
  }

  async function creditEvent(event: OnrampProviderEvent, rawBody: string): Promise<OnrampCredit> {
    const intentId = intentIdOf(event, rawBody);
    const intent = intentId === null ? undefined : intents.get(intentId);
    const amount = BigInt(event.amountUsdc ?? 0);
    if (amount <= 0n) throw new WebhookError(`event ${event.ref} carries no positive amount`, "amount-missing");

    const holdback = holdbackOf(event, intent, amount);
    const record = (patch: Partial<OnrampCredit>): OnrampCredit => {
      const credit: OnrampCredit = {
        ref: event.ref,
        intent: intentId,
        wallet: event.wallet,
        amountUsdc: amount.toString(),
        amountPln: (intent?.plnMinor ?? usdcToPln(amount, intent?.rateScaled ?? config.rateScaled)).toString(),
        publicHoldback: holdback.toString(),
        confidentialAmount: confidentialMoveAmount(amount, holdback).toString(),
        confidentialPending: true,
        status: "credited",
        signatures: [],
        at: now(),
        ...patch,
      };
      credits.set(credit.ref, credit);
      if (intentId !== null) creditsByIntent.set(intentId, credit.ref);
      return credit;
    };

    if (!isAddress(event.wallet)) {
      log(`onramp: event ${event.ref} names ${event.wallet}, which is not an address; not crediting`);
      return record({ status: "rejected", reason: `${event.wallet} is not a valid wallet address` });
    }
    // The cap is enforced here and not only at checkout: checkout is advisory,
    // this is where rUSDC is actually created. A rejected credit is final — the
    // (test) money was taken and the operator has to sort it out — so it is
    // recorded rather than retried, and the provider is told we are done.
    try {
      cap.check(event.wallet, amount, now());
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`onramp: event ${event.ref} refused: ${reason}`);
      return record({ status: "rejected", reason });
    }

    const treasury = await deps.treasury();
    // Reserve first, mint second. In mock mode this is what gives the virtual
    // reserve the balance the invariant then checks the mint against; in live
    // mode the USDC already moved and this only records it.
    treasury.creditReserve(amount, `onramp:${event.ref}`);

    const resolved = deps.resolveOwner === undefined ? null : await deps.resolveOwner(event.wallet);
    if (resolved !== null) {
      const wrapped = await treasury.wrapAndMakeConfidential({
        owner: resolved.owner,
        amount,
        publicHoldback: holdback,
        keys: resolved.keys,
        ref: `onramp:${event.ref}`,
      });
      cap.record(event.wallet, amount, now());
      log(`onramp: credited ${formatUsdc(amount)} rUSDC to ${event.wallet} (confidential ${formatUsdc(wrapped.confidentialAmount)})`);
      return record({ confidentialPending: false, invariant: reportForLog(wrapped.invariantAfter) });
    }

    // Production path: mint to the public balance. `deposit` + `apply pending`
    // are owner-signed and re-encrypt the balance locally, so only the wallet
    // can finish the move — the app does it over a sponsored transaction.
    const wrapped = await treasury.wrap({ wallet: event.wallet as Address, amount, ref: `onramp:${event.ref}` });
    cap.record(event.wallet, amount, now());
    log(`onramp: credited ${formatUsdc(amount)} rUSDC to ${event.wallet}, public; confidential move pending the wallet's keys`);
    return record({ signatures: wrapped.signatures, invariant: reportForLog(wrapped.invariantAfter) });
  }

  /** Where the holdback comes from: the signed event's metadata, else the stored intent, clamped. */
  function holdbackOf(event: OnrampProviderEvent, intent: OnrampIntent | undefined, amount: bigint): bigint {
    const requested = event.holdback ?? intent?.holdback ?? 0n;
    if (requested <= amount) return requested;
    // Our own metadata, so this is a bug rather than an attack — but failing the
    // webhook would leave paid-for rUSDC unminted, so clamp and complain.
    log(`onramp: WARNING holdback ${requested} exceeds the credited ${amount}; keeping all of it public`);
    return amount;
  }

  function intentIdOf(event: ProviderEvent, rawBody: string): string | null {
    const fromRef = /^mock-(.+)$/.exec(event.ref);
    if (fromRef?.[1] !== undefined) return fromRef[1];
    try {
      const body = JSON.parse(rawBody) as { data?: { object?: { metadata?: { intent?: unknown } } } };
      const id = body.data?.object?.metadata?.intent;
      return typeof id === "string" && id !== "" ? id : null;
    } catch {
      return null;
    }
  }

  return {
    provider: config.provider,
    rateScaled: config.rateScaled,
    checkout,
    handleWebhook,
    intent: (id: string): OnrampIntent | undefined => intents.get(id),
    /** What the app polls after the hosted page sends the user back. */
    creditForIntent: (id: string): OnrampCredit | undefined => {
      const ref = creditsByIntent.get(id);
      return ref === undefined ? undefined : credits.get(ref);
    },
    credit: (ref: string): OnrampCredit | undefined => credits.get(ref),
    remainingToday: (wallet: string): bigint => cap.remaining(wallet, now()),
    cap: config.maxUsdcPerWalletPerDay,
  };
}

export type Onramp = ReturnType<typeof createOnramp>;

/** Trims the fixed-point tail so the UI shows "4.30" rather than "4.300000", keeping two places. */
export const formatRate = (rateScaled: bigint): string => {
  const text = formatScaled(rateScaled, RATE_DECIMALS).replace(/(\.\d\d\d*?)0+$/, "$1");
  return text;
};

/**
 * JSON for an inline `<script>` block.
 *
 * `JSON.stringify` alone is not safe here: it leaves `<` intact, so a string
 * containing `</script>` closes the block and everything after it is parsed as
 * HTML. Escaping `<`, `>` and `&` as unicode escapes keeps the value identical
 * once the engine parses it, and makes the closing sequence unrepresentable.
 * U+2028/U+2029 are valid JSON but invalid in a JavaScript string literal.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The no-secrets checkout page: shows what was priced server-side and confirms it. */
export function mockCheckoutPage(intent: OnrampIntent, back: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
  const amountPln = formatPln(intent.plnMinor);
  const amountUsdc = formatUsdc(intent.amountUsdc);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulated checkout · Relstate</title>
<style>
  :root { color-scheme: light dark; --ink:#1b1714; --paper:#faf7f2; --line:#e4dbcf; --brand:#1d5f6c; }
  @media (prefers-color-scheme: dark) { :root { --ink:#f3efe9; --paper:#17140f; --line:#352e26; } }
  body { margin:0; min-height:100dvh; display:grid; place-items:center; background:var(--paper); color:var(--ink);
         font:16px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; padding:24px; }
  .card { width:100%; max-width:26rem; background:color-mix(in srgb, var(--paper) 88%, white); border:1px solid var(--line);
          border-radius:20px; padding:28px; box-shadow:0 20px 40px -28px rgba(0,0,0,.35); }
  h1 { font-size:1.35rem; margin:0 0 4px; }
  .tag { display:inline-block; font-size:.72rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase;
         background:#f3e1c2; color:#7a4a14; border-radius:999px; padding:4px 10px; margin-bottom:14px; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:8px 16px; margin:18px 0; font-variant-numeric:tabular-nums; }
  dt { color:color-mix(in srgb, var(--ink) 60%, transparent); } dd { margin:0; text-align:right; font-weight:600; }
  code { font-size:.8rem; word-break:break-all; font-weight:400; }
  button { width:100%; min-height:48px; border:0; border-radius:14px; background:var(--brand); color:#fff;
           font:inherit; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.6; cursor:progress; }
  a { display:block; text-align:center; margin-top:12px; color:inherit; opacity:.7; font-size:.9rem; }
  p.note { font-size:.85rem; opacity:.75; }
  p.err { color:#8a2f21; font-size:.9rem; }
</style></head>
<body>
  <main class="card">
    <span class="tag">Simulated · no card, no money</span>
    <h1>Confirm your top-up</h1>
    <p class="note">This page stands in for Stripe's hosted checkout. Set <code>ONRAMP_PROVIDER=stripe</code> with test keys to use the real one.</p>
    <dl>
      <dt>You pay</dt><dd>${esc(amountPln)} PLN</dd>
      <dt>You receive</dt><dd>${esc(amountUsdc)} rUSDC</dd>
      <dt>Rate</dt><dd>${esc(formatRate(intent.rateScaled))} PLN / USDC</dd>
      <dt>Wallet</dt><dd><code>${esc(intent.wallet)}</code></dd>
    </dl>
    <button id="pay">Pay ${esc(amountPln)} PLN (simulated)</button>
    <p class="err" id="err" hidden></p>
    <a href="${esc(back)}cancelled&intent=${esc(intent.id)}">Cancel and go back</a>
  </main>
  <script type="module">
    const pay = document.getElementById("pay"), err = document.getElementById("err");
    pay.addEventListener("click", async () => {
      pay.disabled = true; err.hidden = true;
      try {
        // The amount is not in this request: the backend reads it from the
        // intent it priced. The page can only say "that one completed".
        const res = await fetch("/api/webhooks/stripe", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ intent: ${jsonForScript(intent.id)} }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "the webhook rejected this confirmation (" + res.status + ")");
        location.href = ${jsonForScript(`${back}done&intent=${intent.id}`)};
      } catch (e) {
        err.textContent = e.message; err.hidden = false; pay.disabled = false;
      }
    });
  </script>
</body></html>`;
}
