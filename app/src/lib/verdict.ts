// The appraiser verdict console, client half (docs/contracts/dispute-mediation.md §4, §10).
//
// This console holds NO key. The appraiser's key lives in the backend (`APPRAISER_KEYPAIRS`) and
// the only thing sent from here is a lease address and a number, under the backend's own
// `VERDICT_CONSOLE_TOKEN` — never `ADMIN_TOKEN`, because that key decides a deposit. The backend
// will not sign for a lease that is not in mediation, and cannot choose the appraiser: it signs
// only as whoever the chain says is bound, or refuses.
//
// Free of React and of web3.js, so the parsing and the error mapping can be tested without a DOM.
import { API } from "@/lib/sponsor";
import { usdc } from "@/lib/utils";

export const VERDICT_PATH = "/api/admin/appraiser/verdict";

/** True when there is a backend to hold the appraiser keys at all. */
export const CONSOLE_AVAILABLE = !!API;

/** What the route reports for a verdict, dry run or real. Amounts arrive as digit strings. */
export interface VerdictView {
  lease: string;
  appraiser: string;
  deduction: number;
  deposit: number;
  toTenant: number;
  toLandlord: number;
  feePaid: number;
  appraiserAta: string;
  /** False when the appraiser has no token account for the lease's mint yet, which the submit creates. */
  appraiserAtaExists: boolean;
}

export interface VerdictResult extends VerdictView {
  dryRun: boolean;
  /** Empty on a dry run. */
  signatures: string[];
}

/**
 * Base units from the decimal amount an operator typed.
 *
 * Deliberately not `Number(x) * 1e6`: that maps "", " ", "1e3" and "0x10" to numbers, and a
 * seventh decimal place would be silently rounded into a different verdict than the one on screen.
 */
export function parseAmountInput(text: string): { base: number } | { error: string } {
  const s = text.trim();
  if (s === "") return { error: "Enter the deduction — 0 for a full refund to the tenant." };
  if (s.startsWith("-")) return { error: "A verdict cannot be negative: it is between 0 and the whole deposit." };
  if (!/^\d+(\.\d{1,6})?$/.test(s))
    return { error: "Use digits, with at most six decimal places (USDC has six), for example 12.5." };
  const [whole, frac = ""] = s.split(".");
  const base = Number(whole) * 1_000_000 + Number(frac.padEnd(6, "0"));
  if (!Number.isSafeInteger(base)) return { error: "That amount is too large to be a deposit deduction." };
  return { base };
}

/**
 * Why this verdict must not be sent, checked here before anything leaves the browser.
 *
 * The program enforces all of it — `0 <= deduction <= deposit` and `Status::Mediation` — so this
 * is not the guard, it is the operator not having to learn it from a failed transaction that cost
 * a demo its momentum.
 */
export function verdictProblem(args: { deductionBase: number; deposit: number; status: string; appraiser: string }): string | null {
  const { deductionBase, deposit, status, appraiser } = args;
  if (status !== "mediation")
    return `This lease is ${status === "closed" ? "already closed" : `in "${status}"`}, not in mediation, so there is no verdict to submit.`;
  if (!appraiser) return "No appraiser is bound to this lease yet, so nobody is entitled to decide it.";
  if (deductionBase > deposit)
    return `A verdict cannot exceed the deposit: ${usdc(deductionBase)} USDC is more than the ${usdc(deposit)} USDC in the vault.`;
  return null;
}

/**
 * The question a dry run answered: a lease and an exact number of base units.
 *
 * The confirm button is authorised by a dry run, so it must only ever be armed for the question
 * that dry run actually answered. Editing either field disarms it, which is the difference between
 * a confirmation and a second, unreviewed decision.
 */
export const asked = (lease: string, deductionBase: number): string => `${lease}:${deductionBase}`;

/** Why the confirm button is or is not armed. */
export type PreviewGate =
  | { armed: true }
  /** Nothing has been previewed yet. */
  | { armed: false; reason: "none" }
  /** The form has changed since the preview, so the preview answers a different question. */
  | { armed: false; reason: "stale" }
  /** The backend's own echo of the lease or amount is not what it was asked about. */
  | { armed: false; reason: "echo" };

/**
 * Whether a held preview authorises submitting this lease and amount.
 *
 * Two independent checks, because they fail for different reasons. `stale` is the operator having
 * edited the form after previewing: the dry run then describes a verdict nobody reviewed, and
 * confirming it would be a second decision wearing the first one's approval. `echo` is the
 * *backend* having answered about a different lease or amount than it was asked — a confused
 * deputy, a proxy serving a cached body, a wrong deployment — and it must never be smoothed over,
 * because the numbers on screen would then not be the numbers that get signed.
 */
export function previewGate(
  preview: { asked: string; result: Pick<VerdictView, "lease" | "deduction"> } | null | undefined,
  lease: string,
  deductionBase: number,
): PreviewGate {
  if (!preview) return { armed: false, reason: "none" };
  if (preview.asked !== asked(lease, deductionBase)) return { armed: false, reason: "stale" };
  if (preview.result.lease !== lease || preview.result.deduction !== deductionBase) return { armed: false, reason: "echo" };
  return { armed: true };
}

const amount = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The route's JSON, as numbers. */
export function verdictView(body: unknown): VerdictResult {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    dryRun: b.dryRun === true,
    lease: typeof b.lease === "string" ? b.lease : "",
    appraiser: typeof b.appraiser === "string" ? b.appraiser : "",
    deduction: amount(b.deduction),
    deposit: amount(b.deposit),
    toTenant: amount(b.toTenant),
    toLandlord: amount(b.toLandlord),
    feePaid: amount(b.feePaid),
    appraiserAta: typeof b.appraiserAta === "string" ? b.appraiserAta : "",
    appraiserAtaExists: b.appraiserAtaExists === true,
    signatures: Array.isArray(b.signatures) ? b.signatures.filter((s): s is string => typeof s === "string") : [],
  };
}

/**
 * What an operator should read for the ways this route refuses. `code` is the backend's own.
 *
 * `body` is whatever came back on a failure, which is `unknown` for real: a bare `null` is valid
 * JSON and `res.json()` resolves it rather than rejecting, so a `.catch` fallback never sees it.
 * Reading a field off it unguarded would throw a TypeError in place of the message an operator
 * needs — the worst possible failure for the one screen that pays out a deposit.
 */
export function consoleErrorMessage(status: number, body: unknown): string {
  const b = (typeof body === "object" && body !== null ? body : {}) as { error?: unknown; code?: unknown };
  const error = typeof b.error === "string" ? b.error : "";
  const code = typeof b.code === "string" ? b.code : "";
  if (status === 401 || status === 403)
    return error.includes("not configured")
      ? "This backend has no VERDICT_CONSOLE_TOKEN set, so its verdict console is switched off."
      : "That console token was refused. Check it — it is the backend's VERDICT_CONSOLE_TOKEN, which is deliberately not the admin token.";
  if (code === "lease-not-allowed") return "This backend only signs verdicts for the leases on its VERDICT_CONSOLE_LEASES list, and this is not one of them.";
  if (code === "malformed-body") return error || "The backend could not read the request.";
  if (code === "unavailable") return error || "The backend cannot reach the network right now.";
  if (code === "lease-layout") return "The backend's lease layout no longer matches the deployed program, so it will not sign anything. This needs a redeploy or a layout fix.";
  if (status === 429) return "Too many requests to the console. Wait a moment and try again.";
  return error || `The backend refused the verdict (HTTP ${status}).`;
}

/**
 * Asks the backend to preview (`dryRun`) or sign a verdict.
 *
 * `deduction` goes as a digit string because the route takes digits only — it refuses anything
 * `BigInt()` would coerce, so that an empty form field cannot become a live verdict of 0 — and the
 * route refuses unknown fields, so nothing else may be added to this body.
 */
export async function postVerdict(token: string, input: { lease: string; deduction: number; dryRun: boolean }): Promise<VerdictResult> {
  if (!API) throw new Error("This console needs a backend: set VITE_API to the deployment that holds the appraiser keys.");
  if (token.trim() === "") throw new Error("Paste the console token first.");
  const res = await fetch(`${API}${VERDICT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token.trim()}` },
    body: JSON.stringify({ lease: input.lease, deduction: String(Math.trunc(input.deduction)), dryRun: input.dryRun }),
  });
  // Unknown, not a shape: a parse failure gives {}, but a body of literal `null` parses fine and
  // arrives as null. Both callees below take it from here.
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(consoleErrorMessage(res.status, body));
  return verdictView(body);
}
