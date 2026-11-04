// Outbound e-mail, behind one interface. Contract 4's shape ("every external vendor sits behind one
// of these") applied to the one message this backend sends: the appraiser invitation.
//
// What the demo needs is a sender that makes the link reachable on a stage, and what a real
// deployment needs is a seam that a provider drops into without touching `invites.ts`. So: an
// interface, a console sender, a no-op sender, a Resend sender in `email-resend.ts`, and one
// `createEmailSender` that picks between them. Resend added no dependency either — it is one POST
// over `fetch`.
//
// The one security rule in this file: **an invite link is a bearer token, so it never reaches a
// shared log in live mode.** The console sender prints it in mock mode, where the operator is the
// only reader and the demo depends on it, and redacts it anywhere else. `redactSecrets` cannot help
// here — the token is freshly minted per invite and is not a configured secret — so the sender has
// to be the thing that knows.
import { createResendEmailSender, resendConfigFromEnv } from "./email-resend.ts";
import { env } from "./env.ts";

export type OutboundEmail = {
  to: string;
  subject: string;
  /** Plain text. No HTML: nothing here needs it, and a text body cannot carry a tracking pixel. */
  text: string;
  /**
   * The parts of `text` that must never be logged, in full. The console sender replaces each one
   * with `<redacted>` in live mode. Passed explicitly rather than guessed at, because only the
   * caller knows which substring is the bearer token.
   */
  secrets?: readonly string[];
};

export interface EmailSender {
  /** For the response's `delivery.sender` and for the log line. */
  readonly name: string;
  /** True when this sender actually delivers; false for {@link noneEmailSender}. */
  readonly delivers: boolean;
  send(email: OutboundEmail): Promise<void>;
}

/** `biuro@acme.example` → `b***@acme.example`. What a route may echo back: enough to confirm the address, not enough to learn it. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = address.slice(0, at);
  return `${local[0]}***${address.slice(at)}`;
}

/**
 * Minimal, deliberately strict address check: one `@`, something either side, no whitespace, a dot
 * in the domain. Not RFC 5322 — a full parser accepts addresses no mail server would route, and the
 * failure this is guarding against is a party typing a wallet address into the e-mail field.
 */
export const looksLikeEmail = (address: string): boolean =>
  /^[^\s@,;:<>"]+@[^\s@,;:<>"]+\.[^\s@,;:<>".]+$/.test(address) && address.length <= 254;

/**
 * Writes the message to this process's log. The demo's sender: the operator reads the link off the
 * console (or off the `POST /api/invites` response, which carries it in mock mode only) and opens it
 * as the appraiser would.
 */
export function createConsoleEmailSender({ log = console.log, mode = env.mode }: { log?: (...args: unknown[]) => void; mode?: string } = {}): EmailSender {
  return {
    name: "console",
    delivers: true,
    send(email) {
      const body = mode === "mock" ? email.text : (email.secrets ?? []).reduce((text, secret) => (secret === "" ? text : text.split(secret).join("<redacted>")), email.text);
      log(`e-mail to ${maskEmail(email.to)}: ${email.subject}\n${body}`);
      return Promise.resolve();
    },
  };
}

/**
 * Accepts the message and does nothing with it. The live-mode default, because a backend with no
 * mail provider configured should say it did not send rather than log a token and claim it did —
 * `POST /api/invites` reports `delivery.sent: false` and the party passes the link on themselves.
 */
export const noneEmailSender = (): EmailSender => ({
  name: "none",
  delivers: false,
  send: () => Promise.resolve(),
});

/**
 * Which sender {@link createEmailSender} will pick, without building it.
 *
 * Split out from the factory so `/health` can name the configured sender without constructing one
 * (and so without needing the invites service at all), while the answer stays one function's
 * opinion rather than two that can drift. Blank picks the sender that is honest for the mode:
 * `console` in mock, where the operator reads the link off the log, and `none` in live, so a
 * deployment with nothing configured never claims to have sent an e-mail.
 */
export function emailSenderName({ sender = env.invites.emailSender, mode = env.mode }: { sender?: string; mode?: string } = {}): "console" | "resend" | "none" {
  const chosen = sender !== "" ? sender : mode === "mock" ? "console" : "none";
  return chosen === "console" ? "console" : chosen === "resend" ? "resend" : "none";
}

/**
 * The configured sender. `INVITE_EMAIL_SENDER` is validated at boot (`assertEnvConsistent`), so an
 * unknown value never reaches here, and `resend` is only reachable with its key and from address
 * both set.
 *
 * A further provider is added in exactly one place: another `case` here (plus its name in
 * {@link emailSenderName}) and its own file implementing {@link EmailSender}, the way
 * `email-resend.ts` does. Nothing in `invites.ts` changes.
 */
export function createEmailSender({ log, sender = env.invites.emailSender, mode = env.mode, fetch }: { log?: (...args: unknown[]) => void; sender?: string; mode?: string; fetch?: typeof globalThis.fetch } = {}): EmailSender {
  switch (emailSenderName({ sender, mode })) {
    case "console":
      return createConsoleEmailSender({ log, mode });
    case "resend":
      // `fetch` is a test seam only; in the server it is left undefined and the global is used.
      return createResendEmailSender(resendConfigFromEnv(), { log, ...(fetch === undefined ? {} : { fetch }) });
    default:
      return noneEmailSender();
  }
}
