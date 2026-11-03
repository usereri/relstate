// Which backend `VITE_EMBEDDED_WALLET*` resolves to, and why it sometimes resolves to none.

import { EMBEDDED_MODE, embeddedOffReason } from "./mode";
import { mockBackend } from "./mock";
import { privyBackend, type PrivySdk } from "./privy";
import type { EmbeddedBackend } from "./backend";

let privySdk: PrivySdk | null = null;

/**
 * Hands the Privy SDK to {@link privyBackend}. Called by the binding module described at the top
 * of ./privy.ts, which is the only file that imports `@privy-io/react-auth`.
 */
export function registerPrivySdk(sdk: PrivySdk | null): void {
  privySdk = sdk;
}

/** The backend to use, or the reason there is none. Cheap: safe to call during render. */
export function activeBackend(): { backend: EmbeddedBackend; reason: null } | { backend: null; reason: string } {
  if (EMBEDDED_MODE === "mock") return { backend: mockBackend, reason: null };
  if (EMBEDDED_MODE === "privy") {
    if (!privySdk)
      return {
        backend: null,
        reason:
          "Privy is configured (VITE_EMBEDDED_WALLET_APP_ID) but its SDK is not bound in this build. " +
          "See the header of app/src/auth/privy.ts for the two steps, or set VITE_EMBEDDED_WALLET=mock to use the demo wallet.",
      };
    return { backend: privyBackend(privySdk), reason: null };
  }
  return { backend: null, reason: embeddedOffReason() ?? "Email sign-up is not configured." };
}
