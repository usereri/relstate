// The one interface an embedded-wallet provider has to satisfy.
//
// Deliberately promise-shaped and free of React, even though Privy's own SDK is a set of hooks:
// that keeps the whole login state machine testable without a DOM, and leaves React to the two
// components in this directory. A provider whose API is hook-based is bridged by its binding
// module (see ./privy.ts), not by this contract.

import type { Role, WalletProvider } from "@/lib/wallet";

export type { Role, WalletProvider };

/**
 * A provider of email-login wallets.
 *
 * Every method takes the `role`, because the app lets one browser be a landlord in one tab and a
 * tenant in another: each role keeps its own signed-in account, exactly as the extension and
 * built-in test wallets already do (`relstate.wallet.<role>`).
 */
export interface EmbeddedBackend {
  id: "mock" | "privy";
  /** What the sign-up row calls this option. */
  label: string;
  /** The small print under it. The mock's says out loud that the wallet is a stand-in. */
  note: string;
  /** True when a one-time code from the inbox is part of the flow, so the UI asks for one. */
  needsCode: boolean;
  /** An already-signed-in wallet, without asking the user for anything. Null when there is none. */
  restore(role: Role): Promise<WalletProvider | null>;
  /**
   * Starts an email login. Resolves with the wallet when the provider needs nothing else
   * ({@link needsCode} false), or with null once a code has been sent.
   */
  start(email: string, role: Role): Promise<WalletProvider | null>;
  /** Completes a login that sent a code. */
  submitCode(code: string, role: Role): Promise<WalletProvider>;
  /** Forgets the account in this browser. Does not touch the chain. */
  signOut(role: Role): Promise<void>;
}

/** Where an email login has got to. `linking` is this app exchanging the wallet for a session. */
export type EmbeddedStatus = "idle" | "sending" | "code" | "creating" | "linking" | "ready" | "error";

/** Normalised so one person always lands on one wallet, however they type their address. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Good enough to catch a typo before we provision anything; the provider does the real check. */
export const looksLikeEmail = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizeEmail(email));
