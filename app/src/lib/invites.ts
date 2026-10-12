// The appraiser invitation, client half: how a wallet gets from the appraisal company to the two
// parties (docs/contracts/dispute-mediation.md §4 phase 2, §10 item 3).
//
// The program cannot know which wallet belongs to "Acme Wycena". It sees a name string and,
// separately, a wallet, and its whole guarantee is "both parties confirmed this wallet" — never
// "this wallet is Acme Wycena". The link is an assertion the parties make out of band, and these
// four routes are that band:
//
//   POST /api/invites              a party invites the agreed company by e-mail
//   GET  /api/invites/:token       PUBLIC: the case summary the appraiser lands on
//   POST /api/invites/:token/claim the appraiser, signed in, claims it with their own wallet
//   GET  /api/invites?lease=       a party reads the claimed wallet, to propose or confirm it
//
// **Nothing in the mediation flow depends on this.** The program only ever sees a pubkey, so a
// deployment without a backend — or one whose invite route is down — leaves the two parties
// pasting the wallet the appraiser told them some other way. Every failure here is reported and
// then survivable, which is why `createInvite` is a separate button from `propose_appraiser_key`.
//
// Free of React and of web3.js, so the parsing is testable without a DOM.
import { API, sessionAuth } from "@/lib/sponsor";
import { companyName } from "@/lib/appraisers";

/** True when this deployment has a backend that could carry an invitation at all. */
export const INVITES_AVAILABLE = !!API;

/** Where the appraiser's link points. The backend builds the same URL for the e-mail it sends. */
export const inviteUrl = (token: string, origin = globalThis.location?.origin ?? ""): string =>
  `${origin}${globalThis.location?.pathname ?? "/"}#/invite/${encodeURIComponent(token)}`;

/** `pending` until the appraiser claims the invitation with a wallet, then `claimed`. */
export type InviteStatus = "pending" | "claimed";

/**
 * `GET /api/invites/:token` — public, and the only thing a signed-out appraiser can read.
 *
 * It carries the whole case summary on purpose: somebody who has just been asked to appraise a
 * flat should be able to see what they are being asked, and who is asking, before creating an
 * account. It carries no e-mail address, because the invitation is addressed to the company and
 * the other party's address is none of anyone's business.
 */
export interface InviteCase {
  lease: string;
  /** The agreed company, in the display form the chain holds. */
  companyName: string;
  /** Hex `name_hash`; equals `dispute.agreed_name_hash` or the backend would not have issued it. */
  nameHash: string;
  /** Base units of the lease mint. Arrives as a digit string and is kept as a number here. */
  agreedFee: number;
  mint: string;
  depositAmount: number;
  landlord: string;
  tenant: string;
  selectionDeadline: number;
  status: InviteStatus;
  /** The wallet that claimed it, or `""` while it is still pending. */
  claimedWallet: string;
  expiresAt: number;
}

/** `POST /api/invites` — what the party who sent the invitation gets back. */
export interface IssuedInvite {
  lease: string;
  companyName: string;
  nameHash: string;
  agreedFee: number;
  /**
   * MASKED, e.g. `b***@acme.example`. The backend never returns the address it was given, so this
   * is safe to show to the party who typed it and useless to anyone else.
   */
  email: string;
  expiresAt: number;
  delivery: { sender: "console" | "none"; sent: boolean };
  /**
   * The invitation link, present ONLY when the backend runs in mock mode — there is no mail
   * server on a stage, and the demo has to be able to open the appraiser's page. In live mode it
   * is absent and the token reaches the appraiser by e-mail alone.
   */
  url: string;
}

/** `GET /api/invites?lease=` — the pending invitation for a lease, as a party sees it. */
export interface LeaseInvite {
  companyName: string;
  nameHash: string;
  agreedFee: number;
  status: InviteStatus;
  /** Exactly the pubkey to pass to `propose_appraiser_key` / `confirm_appraiser_key`; `""` until claimed. */
  wallet: string;
  claimedAt: number;
  expiresAt: number;
  issuedBy: "landlord" | "tenant";
}

/** `POST /api/invites/:token/claim` — what the appraiser gets back on claiming. */
export interface ClaimedInvite {
  lease: string;
  companyName: string;
  wallet: string;
  claimedAt: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** Amounts arrive as digit strings (u64 does not fit a JSON number safely); a bad one reads as 0. */
const amount = (v: unknown): number => {
  const n = Number(typeof v === "string" || typeof v === "number" ? v : NaN);
  return Number.isFinite(n) ? n : 0;
};
const status = (v: unknown): InviteStatus => (v === "claimed" ? "claimed" : "pending");
/** Every field is read off an object that may be anything at all: `null` parses as valid JSON. */
const object = (body: unknown): Record<string, unknown> => (typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {});

export function inviteCase(body: unknown): InviteCase {
  const b = object(body);
  return {
    lease: str(b.lease),
    // The name is shown beside an amount and comes from off chain, so it is sanitised here even
    // though the backend reports the chain's own display form.
    companyName: companyName(str(b.companyName)),
    nameHash: str(b.nameHash).toLowerCase(),
    agreedFee: amount(b.agreedFee),
    mint: str(b.mint),
    depositAmount: amount(b.depositAmount),
    landlord: str(b.landlord),
    tenant: str(b.tenant),
    selectionDeadline: amount(b.selectionDeadline),
    status: status(b.status),
    claimedWallet: str(b.claimedWallet),
    expiresAt: amount(b.expiresAt),
  };
}

export function issuedInvite(body: unknown): IssuedInvite {
  const b = object(body);
  const delivery = object(b.delivery);
  return {
    lease: str(b.lease),
    companyName: companyName(str(b.companyName)),
    nameHash: str(b.nameHash).toLowerCase(),
    agreedFee: amount(b.agreedFee),
    email: str(b.email),
    expiresAt: amount(b.expiresAt),
    delivery: { sender: delivery.sender === "console" ? "console" : "none", sent: delivery.sent === true },
    url: str(b.url),
  };
}

export function leaseInvite(body: unknown): LeaseInvite | null {
  const b = object(body);
  if (b.invite === null || b.invite === undefined) return null;
  const i = object(b.invite);
  return {
    companyName: companyName(str(i.companyName)),
    nameHash: str(i.nameHash).toLowerCase(),
    agreedFee: amount(i.agreedFee),
    status: status(i.status),
    wallet: str(i.wallet),
    claimedAt: amount(i.claimedAt),
    expiresAt: amount(i.expiresAt),
    issuedBy: i.issuedBy === "tenant" ? "tenant" : "landlord",
  };
}

export function claimedInvite(body: unknown): ClaimedInvite {
  const b = object(body);
  return { lease: str(b.lease), companyName: companyName(str(b.companyName)), wallet: str(b.wallet), claimedAt: amount(b.claimedAt) };
}

/**
 * What a person should read for the ways these routes refuse, by the backend's own `code`.
 *
 * Each of these is reachable by somebody pressing a button on a screen that was loaded a moment
 * before the other side moved, so each says what to do rather than naming a route.
 */
export function inviteErrorMessage(httpStatus: number, body: unknown): string {
  const b = object(body);
  const error = str(b.error);
  const code = str(b.code);
  switch (code) {
    case "invite-invalid":
      return "This invitation link is not valid. Ask the landlord or the tenant to send a fresh one — issuing a new invitation cancels the old link.";
    case "invite-expired":
      return "This invitation has expired. The two parties have a single window to agree on an appraiser, and it has closed or is about to.";
    case "already-claimed":
      return "This invitation has already been claimed by a different account. If that was not you, tell the party who invited you: they can issue a new invitation.";
    case "wallet-is-party":
      return "This account is the landlord or the tenant of that lease, and the program will not accept a verdict from either of them. Sign in with the company's own account.";
    case "not-a-party":
      return "Only this lease's landlord or tenant can do that.";
    case "lease-not-in-mediation":
      return "That lease is not in mediation, so there is nobody to invite.";
    case "name-not-agreed":
      return "You have not agreed on a company yet, so there is no one to invite. Pick the same company as the other side first.";
    case "name-mismatch":
      return "That is not the company the two of you agreed on. Invite the agreed one, exactly as it is spelled on this screen.";
    case "appraiser-already-bound":
      return "An appraiser is already bound to this lease, so the selection is closed.";
    case "invalid-name":
      return error || "That company name cannot be used.";
    case "malformed-body":
    case "malformed-query":
      return error || "The backend could not read the request.";
  }
  if (httpStatus === 401) return "Your session with the backend has expired. Reload the page and sign in again.";
  if (httpStatus === 429) return "Too many invitations from this account. Wait a moment and try again.";
  return error || `The invitation service refused the request (HTTP ${httpStatus}).`;
}

const noBackend = () =>
  new Error("This window has no backend configured (VITE_API), so it cannot send an invitation. Ask the appraiser for their account address instead.");

/**
 * A bearer token when the session layer has one, and no header at all when it does not.
 *
 * Omitting it rather than failing early keeps the unsponsored local run usable: the backend answers
 * 401 and {@link inviteErrorMessage} says what that means, which is better than this module
 * deciding on the backend's behalf which routes need authenticating.
 */
async function auth(): Promise<Record<string, string>> {
  try {
    return { authorization: `Bearer ${await sessionAuth()}` };
  } catch {
    return {};
  }
}

async function parse<T>(res: Response, read: (body: unknown) => T): Promise<T> {
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(inviteErrorMessage(res.status, body));
  return read(body);
}

/** A party invites the agreed company. Re-issuing invalidates the previous link and its claim. */
export async function createInvite(input: { lease: string; companyName: string; email: string }): Promise<IssuedInvite> {
  if (!API) throw noBackend();
  const res = await fetch(`${API}/api/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth()) },
    body: JSON.stringify({ lease: input.lease, companyName: input.companyName, email: input.email.trim() }),
  });
  return parse(res, issuedInvite);
}

/**
 * The case summary behind an invitation link. Public, so this is what a signed-out visitor sees.
 *
 * A 404 is `null` rather than a throw: a stale or mistyped link is a normal thing to land on and
 * the page says so itself. Everything else is raised, because then the service exists and is
 * broken, which is worth seeing.
 */
export async function loadInvite(token: string): Promise<InviteCase | null> {
  if (!API) throw noBackend();
  const res = await fetch(`${API}/api/invites/${encodeURIComponent(token)}`);
  if (res.status === 404) return null;
  return parse(res, inviteCase);
}

/**
 * The appraiser claims the invitation with the wallet their own sign-in created.
 *
 * The body is empty on purpose: the wallet comes from the session, so this page cannot claim an
 * invitation for a key it does not hold. Idempotent for the same wallet.
 */
export async function claimInvite(token: string): Promise<ClaimedInvite> {
  if (!API) throw noBackend();
  const res = await fetch(`${API}/api/invites/${encodeURIComponent(token)}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth()) },
    body: "{}",
  });
  return parse(res, claimedInvite);
}

/** A party reads the invitation on their lease, and with it the wallet to propose or confirm. */
export async function loadLeaseInvite(lease: string): Promise<LeaseInvite | null> {
  if (!API) throw noBackend();
  const res = await fetch(`${API}/api/invites?lease=${encodeURIComponent(lease)}`, { headers: await auth() });
  if (res.status === 404) return null;
  return parse(res, leaseInvite);
}
