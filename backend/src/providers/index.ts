import type { Provider } from "../contracts";

/** Mock used when no vendor keys are set: starts instantly and approves anything. */
export const mock = (kind: "kyc" | "onramp" | "offramp"): Provider => ({
  async start(wallet) {
    return { url: `/mock/${kind}?wallet=${wallet}` };
  },
  async webhook(_h, raw) {
    const b = JSON.parse(raw);
    const done = { kyc: "kyc.approved", onramp: "onramp.completed", offramp: "offramp.completed" } as const;
    return { kind: done[kind], wallet: b.wallet, ref: `mock-${Date.now()}`, amountUsdc: b.amountUsdc };
  },
});

// Real clients are swapped in by workstreams D (kyc) and E (onramp/offramp):
//   process.env.KYC_PROVIDER === "sumsub" ? sumsub : mock("kyc")
export const kyc = (): Provider => mock("kyc");
export const onramp = (): Provider => mock("onramp");
export const offramp = (): Provider => mock("offramp");
