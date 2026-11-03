// The mock embedded wallet: an email and a keypair this page derives itself.
//
// It exists so the email sign-up — the demo's first thirty seconds — runs with NO secrets and no
// provider account: `VITE_EMBEDDED_WALLET=mock` is all it takes. Everything downstream of the
// wallet (sponsored fees, confidential balances, the backend session) is the real thing; only the
// custody is faked.
//
// SECURITY, stated plainly: the key is derived from the email address with a public seed, so
// anyone who knows the address can reconstruct the wallet. That is the opposite of what a real
// embedded wallet promises, which is why this is the `mock` provider, why the UI labels it a demo
// wallet, and why `mode.ts` never enables it by default. It buys two things worth having on stage:
// the same email always comes back to the same wallet (a reload, a cleared cache or a second
// browser all resume), and the demo is reproducible — `scripts/setup-demo.ts`-style funding can
// target an address derived ahead of time.

import * as anchor from "@anchor-lang/core";
import { sha256 } from "@noble/hashes/sha2";
import { embeddedKeypairWallet } from "@/lib/wallet";
import { normalizeEmail, type EmbeddedBackend, type Role, type WalletProvider } from "./backend";

const { Keypair } = anchor.web3;

/** Versioned so a change of derivation is a visibly different wallet rather than a silent one. */
const SEED_PREFIX = "relstate-embedded-mock/v1:";

/** The keypair an address maps to. Same address in, same wallet out, on any machine. */
export const mockKeypair = (email: string) => Keypair.fromSeed(sha256(new TextEncoder().encode(SEED_PREFIX + normalizeEmail(email))));

/** The address an email will get, without signing anything in. */
export const mockAddressFor = (email: string): string => mockKeypair(email).publicKey.toBase58();

// Role-scoped, so a landlord tab and a tenant tab in one browser are two different people.
const storageKey = (role: Role) => `relstate.embedded.${role}`;

/** The email signed in for a role in this browser, if any. */
export function storedEmail(role: Role): string | null {
  try {
    const raw = localStorage.getItem(storageKey(role));
    if (!raw) return null;
    const email = (JSON.parse(raw) as { email?: unknown }).email;
    return typeof email === "string" && email !== "" ? email : null;
  } catch {
    return null;
  }
}

function rememberEmail(role: Role, email: string): void {
  try {
    localStorage.setItem(storageKey(role), JSON.stringify({ email, at: Date.now() }));
  } catch {
    /* private mode: the email is simply asked again on reload */
  }
}

export function forgetEmail(role: Role): void {
  try {
    localStorage.removeItem(storageKey(role));
  } catch {
    /* nothing was stored */
  }
}

/** The signer for an email, as the wallet contract's `embedded` kind. */
export const mockWalletFor = (email: string): WalletProvider => embeddedKeypairWallet(mockKeypair(email));

export const mockBackend: EmbeddedBackend = {
  id: "mock",
  label: "Continue with email",
  note: "Creates a demo wallet on this device. No extension, no seed phrase, no SOL.",
  needsCode: false,

  async restore(role) {
    const email = storedEmail(role);
    return email ? mockWalletFor(email) : null;
  },

  async start(email, role) {
    const normalized = normalizeEmail(email);
    if (normalized === "") throw new Error("Enter an email address.");
    rememberEmail(role, normalized);
    return mockWalletFor(normalized);
  },

  async submitCode() {
    // `needsCode` is false, so the UI never asks for one and never calls this.
    throw new Error("The demo wallet does not send a confirmation code.");
  },

  async signOut(role) {
    forgetEmail(role);
  },
};
