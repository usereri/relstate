import type { Provider, ProviderEvent } from "../contracts.ts";

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

// Real clients are swapped in by workstreams D (kyc) and E (onramp/offramp):
//   process.env.KYC_PROVIDER === "sumsub" ? sumsub : mock("kyc")
export const kyc = (): Provider => mock("kyc");
export const onramp = (): Provider => mock("onramp");
export const offramp = (): Provider => mock("offramp");
