// Real outbound e-mail: Resend (https://resend.com/docs/api-reference/emails/send-email).
//
// This is the seam email.ts describes, taken up: one `case "resend"` there, this file here, and
// nothing in `invites.ts` changes. Plain REST over `fetch` rather than the `resend` npm package,
// for the reason stripe.ts and kyc-sumsub.ts talk REST — this is one endpoint and three headers,
// and the package would be a dependency the backend does not otherwise need.
//
// **At most two attempts, inside one hard budget.** Unlike the vendor clients in `providers/`, this
// one does not go through `retryingFetch`: `POST /api/invites` is a synchronous route a party is
// waiting on, and the retrying fetch's eight attempts with backoff would hold that request open for
// minutes. Instead there is one `AbortSignal.timeout(timeoutMs)` covering the whole send and a
// single retry for a rate limit or a transient 5xx, which the idempotency key makes safe. Failing
// fast after that is not lossy: `invites.ts` keeps the invite either way and answers
// `delivery.sent: false`, so the party passes the link on themselves and can re-issue.
//
// WHAT NEVER LEAVES THIS FILE. The invite link is a bearer token (email.ts's rule), and the
// request body carries it, so:
//
//   * nothing here logs `email.text`, and no thrown message quotes it — `invites.ts` logs whatever
//     this throws, and that log is shared;
//   * the *response* body is read and then mostly discarded. Only the message id (on success) and
//     Resend's machine-readable `name` code (on failure) are kept. Resend's free-text `message`
//     never reaches a log, because a validation error can quote parts of the request we just took
//     care not to log;
//   * the recipient's address is not logged here at all, masked or otherwise. `invites.ts` already
//     prints one summary line per invite with `to=` masked, immediately after this returns, so
//     there is nothing to add and one less place to get it wrong. That also keeps this file free of
//     any runtime import from email.ts, which would otherwise be an import cycle.
//
// `RESEND_API_KEY` is registered in `secretValues()` (keys.ts), so even a stray top-level error
// printing an arbitrary string cannot reveal it.
import { createHash } from "node:crypto";
import type { EmailSender, OutboundEmail } from "./email.ts";
import { env } from "./env.ts";

/** Raised when the Resend call itself fails, so the caller can report it without echoing the key. */
export class ResendApiError extends Error {
  /** HTTP status, or 0 when the request never got an answer (network failure or timeout). */
  readonly status: number;
  /** Resend's own error identifier (`validation_error`, `rate_limit_exceeded`, …) when it sent one. */
  readonly resendCode: string | undefined;
  constructor(message: string, status: number, resendCode?: string) {
    super(message);
    this.status = status;
    this.resendCode = resendCode;
  }
}

export type ResendConfig = {
  apiKey: string;
  /** `invites@relstate.casa` or `Relstate <invites@relstate.casa>`; Resend takes either verbatim. */
  from: string;
  apiBase: string;
  /** Ceiling on how long `POST /api/invites` may wait for Resend. */
  timeoutMs: number;
};

type Fetch = typeof fetch;

export const resendConfigFromEnv = (): ResendConfig => ({
  apiKey: env.invites.resendApiKey,
  from: env.invites.emailFrom,
  apiBase: env.invites.resendApiBase,
  timeoutMs: env.invites.emailTimeoutMs,
});

/**
 * `Idempotency-Key` for one message: a digest of the message itself, so the same message retried is
 * the same key and Resend replays its first answer instead of sending twice (24 h window, 256-char
 * limit — this is 59).
 *
 * Deriving it from the payload rather than taking an id from the caller is what keeps `invites.ts`
 * untouched, and it is the stronger guarantee anyway: a key that is a function of the body can
 * never collide with a *different* body, which is the one case Resend answers with 409
 * `invalid_idempotent_request`.
 *
 * Be honest about what it does not do. Every `POST /api/invites` mints a fresh token, so two clicks
 * are two different messages and both go out — deduplicating those is `invites.ts`'s one-live-
 * invite-per-lease rule, not this header. What it does cover is the request Resend accepted whose
 * answer was lost, which is what makes the single retry below safe.
 *
 * The digest is domain-separated and one-way, so it discloses nothing about the token inside.
 */
const idempotencyKeyFor = (email: OutboundEmail, from: string): string =>
  `relstate-invite-${createHash("sha256").update(["relstate/invite-email/v1", from, email.to, email.subject, email.text].join("\n")).digest("base64url")}`;

/** True for the `AbortSignal.timeout` abort below, whose own message does not say what to change. */
const isTimeout = (e: unknown): boolean => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

/**
 * Statuses worth one more try: Resend's own rate limit and its transient server errors. Deliberately
 * not 502/504 (an intermediary we know nothing about), not 4xx other than 429 (a retry changes
 * nothing), and never a timeout — the timeout *is* the budget, so retrying past it is the one thing
 * this must not do.
 */
const RETRY_STATUSES = new Set([429, 500, 503]);

/** Long enough to clear a rate-limit burst, short enough to be invisible inside a 10s budget. */
const RETRY_DELAY_MS = 250;

/** Resolves after `ms`, or as soon as the budget is spent — so the delay can never outlive it. */
const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * What to tell the operator to go and change, for the failures that are configuration rather than
 * weather. Keyed on Resend's documented status/code pairs: a 403 is the domain only when it is a
 * `validation_error` (`restricted_api_key` and `suspended_api_key` also 403, and those are the key),
 * and every 401 is the key (`missing_api_key`, an invalid or deleted one, or a restricted one).
 */
function hintFor(status: number, code: string | undefined): string {
  if (status === 401 || (status === 403 && code !== "validation_error")) {
    return " — check RESEND_API_KEY: Resend reports it as missing, invalid, deleted, inactive or not permitted to send";
  }
  if (status === 403) {
    return " — check that the domain in INVITE_EMAIL_FROM is verified in Resend; until it is, Resend accepts only your own account address as a recipient";
  }
  return "";
}

/**
 * Sends through Resend's REST API. `delivers` is true: a failure is reported as a failure (this
 * throws, `invites.ts` answers `delivery.sent: false`), never as a silent success.
 */
export function createResendEmailSender(config: ResendConfig, deps: { fetch?: Fetch; log?: (...args: unknown[]) => void; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {}): EmailSender {
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? delay;

  return {
    name: "resend",
    delivers: true,
    async send(email: OutboundEmail): Promise<void> {
      // **One budget for the whole send, retry included.** The same signal is passed to both
      // attempts, so the second inherits whatever is left of `timeoutMs` and a retry can never
      // double the time the party is waiting on `POST /api/invites`.
      const signal = AbortSignal.timeout(config.timeoutMs);
      const url = `${config.apiBase.replace(/\/$/, "")}/emails`;
      const headers = {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKeyFor(email, config.from),
      };
      // Text only, like every other sender: nothing in an invitation needs HTML, and a text body
      // cannot carry a tracking pixel. Resend generates `text` from `html` when `text` is absent —
      // sending only `text` is what keeps the message HTML-free end to end.
      const body = JSON.stringify({ from: config.from, to: [email.to], subject: email.subject, text: email.text });

      for (let attempt = 0; ; attempt++) {
        let response: Response;
        try {
          response = await doFetch(url, { method: "POST", headers, body, signal });
        } catch (e) {
          // Never retried. A timeout here is the budget itself, and a network rejection has an
          // unknown outcome — the idempotency key would make another attempt safe, but the point of
          // the budget is that this route answers quickly, and `delivery.sent: false` loses nothing.
          //
          // A `fetch` rejection names the host and the syscall, never a header or the body, so its
          // message is safe to pass on — and without it the operator sees only "fetch failed".
          const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : e instanceof Error ? `: ${e.message}` : "";
          throw new ResendApiError(isTimeout(e) ? `resend did not answer within ${config.timeoutMs}ms` : `resend could not be reached${cause}`, 0);
        }

        let parsed: { id?: unknown; name?: unknown } = {};
        try {
          parsed = (await response.json()) as typeof parsed;
        } catch {
          /* a non-JSON body (a proxy's error page) is an outage; the status carries the story */
        }
        const code = typeof parsed.name === "string" && /^[a-z_]{1,64}$/.test(parsed.name) ? parsed.name : undefined;

        if (response.ok) {
          // The id is Resend's handle for this message in its dashboard: the one thing worth
          // keeping, and it reveals neither the recipient nor the token.
          log(`resend: accepted ${typeof parsed.id === "string" ? parsed.id : "(no id in response)"}`);
          return;
        }

        // One retry, and only for a status where another attempt can plausibly differ. Safe to
        // repeat because the idempotency key is a digest of this exact message, so if Resend did
        // accept the first attempt it replays that answer rather than sending twice.
        if (attempt === 0 && RETRY_STATUSES.has(response.status) && !signal.aborted) {
          log(`resend: HTTP ${response.status}, retrying once`);
          await sleep(RETRY_DELAY_MS, signal);
          if (!signal.aborted) continue;
        }

        throw new ResendApiError(`resend refused the message (HTTP ${response.status}${code === undefined ? "" : ` ${code}`})${hintFor(response.status, code)}`, response.status, code);
      }
    },
  };
}
