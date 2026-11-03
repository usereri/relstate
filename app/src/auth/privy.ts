// The Privy embedded wallet, as an {@link EmbeddedBackend}.
//
// The login flow, the wallet wiring and the error handling are all here and all tested. What is
// NOT here is the import of `@privy-io/react-auth`: this module takes the four calls it needs as a
// {@link PrivySdk} and nothing more.
//
// Why the SDK is not a dependency of this repo (measured, 2026-10-09):
//
//   * `@privy-io/react-auth` pulls 530 top-level packages and takes node_modules to 1.5 GB, with
//     57 `npm audit` findings, for a leg that cannot be exercised without a Privy app id.
//   * its `/solana` entry imports `@solana-program/{memo,token,system}` unconditionally although
//     all three are declared optional peers, so it does not build until they are added too;
//   * its ESM build emits hundreds of Rollup annotation warnings, and a clean `npm run app:build`
//     is a Phase 1 gate.
//
// So the SDK stays out until there is an app id to point it at, and binding it is one small file:
//
//   // app/src/auth/privy-sdk.tsx
//   import { PrivyProvider, useLoginWithEmail, usePrivy } from "@privy-io/react-auth";
//   import { useSolanaWallets } from "@privy-io/react-auth/solana";
//   import { registerPrivySdk } from "./backends";
//   // Hooks are only callable while PrivyProvider is mounted, so a mounted shim publishes them
//   // to the promise-shaped calls below; see `PrivySdk` for the contract each one must satisfy.
//
// and then `npm i @privy-io/react-auth @solana-program/memo @solana-program/token
// @solana-program/system`, `import "@/auth/privy-sdk"` from `main.tsx`, and set
// VITE_EMBEDDED_WALLET_APP_ID. Until then `mode.ts` resolves Privy only when an app id is set and
// `backends.ts` reports exactly this, rather than failing on the user's first click.

import type { EmbeddedSigner } from "@/lib/wallet";
import { embeddedWallet } from "@/lib/wallet";
import { normalizeEmail, type EmbeddedBackend, type Role, type WalletProvider } from "./backend";

/**
 * The whole of Privy this app uses. A binding module supplies it; everything else about the flow
 * is implemented here, so swapping Privy for Turnkey or Web3Auth is another object of this shape.
 */
export interface PrivySdk {
  /** Emails a one-time code to `email`. */
  sendCode(email: string): Promise<void>;
  /** Completes the login with the code the user typed. */
  loginWithCode(code: string): Promise<void>;
  /**
   * The user's embedded Solana wallet, creating it if this is their first login, or null when
   * nobody is logged in. Resolving is allowed to take a moment: that is the "creating your
   * account" state.
   */
  solanaWallet(): Promise<EmbeddedSigner | null>;
  /** Ends the Privy session in this browser. */
  logout(): Promise<void>;
}

/** Privy owns the session, so the email is only remembered to show it back to the user. */
const storageKey = (role: Role) => `relstate.embedded.privy.${role}`;

const remember = (role: Role, email: string) => {
  try {
    localStorage.setItem(storageKey(role), email);
  } catch {
    /* private mode: the address is just not shown back */
  }
};

export const rememberedEmail = (role: Role): string | null => {
  try {
    return localStorage.getItem(storageKey(role));
  } catch {
    return null;
  }
};

const forget = (role: Role) => {
  try {
    localStorage.removeItem(storageKey(role));
  } catch {
    /* nothing was stored */
  }
};

/**
 * A Privy wallet only reaches the rest of the app once it can sign messages: `signMessage` is what
 * the confidential-balance keys are derived from (docs/privacy.md), and `wallet.ts` puts the
 * derivation guard around it. A provider that cannot sign messages is a configuration error worth
 * reporting rather than a wallet worth using.
 */
function asProvider(signer: EmbeddedSigner): WalletProvider {
  if (typeof signer.signMessage !== "function")
    throw new Error("This Privy wallet cannot sign messages, so it could never pay rent privately. Enable message signing for the app's Solana wallets.");
  return embeddedWallet(signer);
}

export function privyBackend(sdk: PrivySdk): EmbeddedBackend {
  /** Privy creates the wallet during login, so "no wallet yet" is a real failure by this point. */
  const requireWallet = async (): Promise<WalletProvider> => {
    const signer = await sdk.solanaWallet();
    if (!signer) throw new Error("Privy signed you in but reported no Solana wallet. Check that embedded Solana wallets are enabled for this app id.");
    return asProvider(signer);
  };

  return {
    id: "privy",
    label: "Continue with email",
    note: "We email you a code. Your wallet is created for you — no extension, no seed phrase, no SOL.",
    needsCode: true,

    async restore() {
      const signer = await sdk.solanaWallet();
      return signer ? asProvider(signer) : null;
    },

    async start(email, role) {
      const normalized = normalizeEmail(email);
      if (normalized === "") throw new Error("Enter an email address.");
      await sdk.sendCode(normalized);
      remember(role, normalized);
      // Null, not a wallet: the code step comes next.
      return null;
    },

    async submitCode(code) {
      const trimmed = code.trim();
      if (trimmed === "") throw new Error("Enter the code we emailed you.");
      await sdk.loginWithCode(trimmed);
      return requireWallet();
    },

    async signOut(role) {
      forget(role);
      await sdk.logout();
    },
  };
}
