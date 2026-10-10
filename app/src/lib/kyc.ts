// Identity, app half (workstream D, docs/contracts/attestation.md).
//
// Like fiat.ts, everything here is HTTP against the backend and nothing can grant anything: the
// attestation is written by the backend's issuer key after the identity provider's signed webhook,
// and "verified" is whatever the chain says. The redirect back from the verification page is a URL
// the user controls, so it only tells the screen to re-read the status.
//
// Free of React and of web3.js so it can be tested without a DOM.
import idl from "@target/idl/relstate.json";
import { API } from "@/lib/sponsor";
import { withSession } from "@/lib/fiat";

export type KycStart = {
  url: string;
  session: string;
  provider: "mock" | "sumsub";
  /** True when no vendor is involved: the page is served by our own backend. */
  simulated: boolean;
  /** The level an approval will write: 1 basic, 2 enhanced. */
  level: number;
  /** Unix seconds an approval would expire at; 0 means never. */
  expiresAt: number;
};

export type AttestationInfo = {
  wallet: string;
  level: 0 | 1 | 2;
  verifiedAt: number;
  expiresAt: number;
  revoked: boolean;
  subjectHash: string;
  issuer: string;
};

export type KycStatus = {
  wallet: string;
  /** A valid attestation exists on chain for this wallet. */
  verified: boolean;
  /** The program is gating `apply` / `propose_lease` on it. */
  requireKyc: boolean;
  issuer: string | null;
  attestation: AttestationInfo | null;
  /** A verification was started and no final decision has landed yet. */
  pending: boolean;
  last: { decision: "approved" | "rejected"; status: string; reason?: string } | null;
  provider: "mock" | "sumsub";
  /** Set when this deployment cannot write attestations at all. */
  unavailable?: string;
};

export const KYC_AVAILABLE = !!API;

export const startKyc = (wallet: string): Promise<KycStart> =>
  withSession(wallet, { path: "/api/kyc/start", method: "POST", body: {}, what: "identity check" });

export const kycStatus = (wallet: string): Promise<KycStatus> =>
  withSession(wallet, { path: "/api/kyc/status", what: "identity status" });

/** Level name for display. */
export const levelName = (level: number): string => (level >= 2 ? "Enhanced" : level === 1 ? "Basic" : "None");

/** "12 Mar 2027", or "never". */
export const expiryText = (expiresAt: number): string =>
  expiresAt === 0 ? "never expires" : `valid until ${new Date(expiresAt * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;

/** Reads `#/app?tab=identity&kyc=done&session=…` left by the verification page's return. */
export function kycReturn(hash = globalThis.location?.hash ?? ""): { outcome: "done" | "cancelled"; session: string } | null {
  if (!hash.includes("?")) return null;
  const params = new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
  const outcome = params.get("kyc");
  const session = params.get("session") ?? "";
  if ((outcome !== "done" && outcome !== "cancelled") || session === "") return null;
  return { outcome, session };
}

/** Drops the kyc query from the hash so a reload does not replay the return. */
export function clearKycReturn(): void {
  try {
    const hash = globalThis.location?.hash ?? "";
    const base = hash.split("?")[0] ?? "#/app";
    history.replaceState(null, "", `${globalThis.location.pathname}${globalThis.location.search}${base}?tab=identity`);
  } catch {
    /* no history API: the banner simply shows again on reload */
  }
}

const KYC_REQUIRED_CODE: number | undefined = (idl as { errors?: { name: string; code: number }[] }).errors?.find((e) => e.name === "KycRequired")?.code;

/**
 * True when an error from `apply` / `propose_lease` is the program's `KycRequired`.
 *
 * The error reaches the app in several shapes depending on the path: Anchor's own message when the
 * wallet pays, a `Custom` code inside a simulation failure when the sponsor backend rejects it,
 * and the log line `custom program error: 0x…`. All of them carry either the name, the message or
 * the code, and the code is read from the IDL so a reordering of the program's errors cannot
 * silently break this.
 */
export function isKycRequired(error: unknown): boolean {
  const text = (() => {
    if (typeof error === "string") return error;
    try {
      const e = error as { message?: string; error?: { errorCode?: { code?: string }; errorMessage?: string }; logs?: string[]; simulationResponse?: unknown };
      return [e?.message, e?.error?.errorCode?.code, e?.error?.errorMessage, ...(e?.logs ?? []), JSON.stringify(e?.simulationResponse ?? "")].filter(Boolean).join(" ");
    } catch {
      return "";
    }
  })();
  if (/KycRequired|valid identity attestation/i.test(text)) return true;
  if (KYC_REQUIRED_CODE === undefined) return false;
  const hex = `0x${KYC_REQUIRED_CODE.toString(16)}`;
  return text.toLowerCase().includes(hex) || new RegExp(`"Custom"\\s*:\\s*${KYC_REQUIRED_CODE}\\b`).test(text);
}
