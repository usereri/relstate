// Contract 4: every external vendor sits behind the `Provider` interface, with a
// `mock` and a real implementation chosen by env. The mock is the default so the
// backend runs with no secrets at all.
import type { Provider, ProviderEvent } from "../contracts.ts";
import { env } from "../env.ts";
import { parsePln, parseRate, parseUsdc } from "./money.ts";
import { createOnramp, type OnrampConfig, type OnrampDeps } from "./onramp.ts";
import { createOfframp, type OfframpConfig, type OfframpDeps } from "./offramp.ts";
import type { StripeConfig } from "./stripe.ts";

/** Mock used when no vendor keys are set: starts instantly and approves anything. */
export const mock = (kind: "kyc" | "onramp" | "offramp"): Provider => ({
  async start(wallet: string) {
    return { url: `/mock/${kind}?wallet=${wallet}` };
  },
  async webhook(_headers: Record<string, string>, raw: string): Promise<ProviderEvent> {
    const body = JSON.parse(raw) as { wallet?: string; amountUsdc?: number };
    const done = { kyc: "kyc.approved", onramp: "onramp.completed", offramp: "offramp.completed" } as const;
    return { kind: done[kind], wallet: body.wallet ?? "", ref: `mock-${Date.now()}`, amountUsdc: body.amountUsdc };
  },
});

// The real client is swapped in by workstream D:
//   process.env.KYC_PROVIDER === "sumsub" ? sumsub : mock("kyc")
export const kyc = (): Provider => mock("kyc");

/** Stripe's half of the env contract, read once so the service never touches `process.env`. */
export function stripeConfigFromEnv(): StripeConfig {
  return {
    secretKey: env.onramp.stripeSecretKey,
    webhookSecret: env.onramp.stripeWebhookSecret,
    apiBase: env.onramp.stripeApiBase,
    toleranceSeconds: env.onramp.webhookToleranceSeconds,
    plnPerUsdc: parseRate(env.onramp.plnPerUsdc),
  };
}

export function onrampConfigFromEnv(backendUrl = `http://localhost:${env.port}`): OnrampConfig {
  return {
    provider: env.onramp.provider,
    rateScaled: parseRate(env.onramp.plnPerUsdc),
    minPln: parsePln(env.onramp.minPln, "ONRAMP_MIN_PLN"),
    maxPln: parsePln(env.onramp.maxPln, "ONRAMP_MAX_PLN"),
    maxUsdcPerWalletPerDay: parseUsdc(env.onramp.maxUsdcPerWalletPerDay, "ONRAMP_MAX_USDC_PER_WALLET_PER_DAY"),
    backendUrl,
    appUrl: env.appUrl.replace(/\/$/, ""),
    stripe: env.onramp.provider === "stripe" ? stripeConfigFromEnv() : undefined,
  };
}

export function offrampConfigFromEnv(): OfframpConfig {
  return {
    rateScaled: parseRate(env.onramp.plnPerUsdc),
    maxUsdcPerWalletPerDay: parseUsdc(env.offramp.maxUsdcPerWalletPerDay, "OFFRAMP_MAX_USDC_PER_WALLET_PER_DAY"),
  };
}

/** Workstream E's on-ramp, configured from env. `services.ts` owns the one instance. */
export const onramp = (deps: Omit<OnrampDeps, "config"> & { config?: OnrampConfig }) =>
  createOnramp({ ...deps, config: deps.config ?? onrampConfigFromEnv() });

export const offramp = (deps: Omit<OfframpDeps, "config"> & { config?: OfframpConfig } = {}) =>
  createOfframp({ ...deps, config: deps.config ?? offrampConfigFromEnv() });

export { createMockOnramp, createOnramp, mockCheckoutPage } from "./onramp.ts";
export { createOfframp } from "./offramp.ts";
export { createStripeOnramp } from "./stripe.ts";
