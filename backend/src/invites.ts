// Appraiser invitations: the off-chain half of binding a wallet to an agreed company name
// (docs/contracts/dispute-mediation.md §4 phase 2, §10 item 3).
//
// WHAT THIS IS, AND WHAT IT IS NOT. The program knows two things about an appraiser: a company
// *name* the two parties agreed on (phase 1, on chain), and, separately, a *wallet* that one party
// proposed and the other confirmed (phase 2, on chain). It cannot check that the name and the wallet
// belong together — "the program's guarantee is exactly *both parties confirmed this wallet*, not
// *this wallet is Acme Wycena*" (§10 item 3).
//
// This module is the carrier between those two facts, and nothing more:
//
//   * a party invites the agreed company by e-mail;
//   * the appraiser opens the link, signs in (the ordinary wallet-session flow, which creates an
//     embedded wallet on first login) and claims the invite, which records the wallet;
//   * both parties' apps read that wallet here and each calls `propose_appraiser_key` /
//     `confirm_appraiser_key` themselves.
//
// **So an invite is an assertion, not an authorisation.** Nothing here can bind an appraiser, move
// a deposit, or make a party's on-chain call for them. If this backend lied about the wallet, the
// parties would confirm a key that is not the company's — which is exactly the trust statement §10
// item 3 already makes about the e-mail channel, and is why the confirmation is a human step on
// both sides rather than something the backend can complete alone.
//
// The constraints that are worth the code, in the order they matter:
//
//   1. **A party may invite only for their own lease, only in `Mediation`, only after the name is
//      agreed, and only for the agreed name** — checked by hashing the name the way the program
//      does and comparing it with `dispute.agreed_name_hash`.
//   2. **An appraiser can claim only the invite they were sent.** The token is bound to lease and
//      name hash, single-use and short-lived, so a claim cannot be moved to another lease or to a
//      company the parties did not agree on.
//   3. **Neither party's e-mail is ever disclosed.** The address is write-only: the sender gets it,
//      the issuing party sees it masked, and no route returns it. The appraiser's page never sees
//      it either.
//   4. **A lease party cannot be the appraiser**, refused here because the program refuses it at
//      propose, confirm and verdict — failing early beats an on-chain `NotMediationParty`.
//
// Stored in memory with a TTL sweep, like the KYC sessions and records, so a restart invalidates
// outstanding invites. That is the fail-closed direction and it is already true of sessions, whose
// HMAC secret is per-process unless `SESSION_SECRET` is set.
import { isAddress, type Address, type GetAccountInfoApi, type Rpc } from "@solana/kit";
import { randomUUID } from "node:crypto";
import { createHmacToken, hmacSecret, verifyHmacToken } from "./auth.ts";
import { RELSTATE_PROGRAM } from "./contracts.ts";
import { InvalidAppraiserName, appraiserNameHash, displayAppraiserName, fetchDispute } from "./dispute.ts";
import { createEmailSender, looksLikeEmail, maskEmail, type EmailSender } from "./email.ts";
import { env } from "./env.ts";
import { idlConstant } from "./layout.ts";
import { fetchLease, type DecodedLease } from "./lease.ts";

/** Everything this module refuses, with the code the route returns. */
export class InviteError extends Error {
  readonly code: string;
  readonly status: 400 | 401 | 403 | 404 | 409;
  constructor(message: string, code: string, status: 400 | 401 | 403 | 404 | 409 = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type Party = "landlord" | "tenant";

/**
 * The lease facts the appraiser's page shows. Snapshotted when the invite is issued: all of them
 * are frozen for the life of the mediation (`escalate_to_mediation` sets the deadline, and the
 * parties and the mint were fixed at `apply`), so a public, rate-limited GET costs no RPC call.
 */
type LeaseFacts = {
  landlord: Address;
  tenant: Address;
  mint: Address;
  depositAmount: bigint;
  selectionDeadline: number;
};

type InviteRecord = LeaseFacts & {
  id: string;
  lease: Address;
  /** The normalised display form, which is what the program stored. */
  companyName: string;
  nameHash: string;
  agreedFee: bigint;
  /** Write-only: used to send, never returned except through {@link maskEmail}. */
  email: string;
  issuedBy: Party;
  /** Unix seconds. */
  expiresAt: number;
  /** The appraiser's wallet, once claimed. */
  wallet: Address | null;
  claimedAt: number | null;
};

/** `GET /api/invites/:token` — public. No e-mail, no token echo. */
export type PublicInviteView = {
  lease: Address;
  companyName: string;
  nameHash: string;
  agreedFee: string;
  mint: Address;
  depositAmount: string;
  landlord: Address;
  tenant: Address;
  selectionDeadline: number;
  verdictWindowSecs: number;
  status: "pending" | "claimed";
  claimedWallet: Address | null;
  expiresAt: number;
};

/** `GET /api/invites?lease=…` — a party of that lease. The wallet here is what phase 2 is called with. */
export type PartyInviteView = {
  companyName: string;
  nameHash: string;
  agreedFee: string;
  status: "pending" | "claimed";
  wallet: Address | null;
  claimedAt: number | null;
  expiresAt: number;
  issuedBy: Party;
};

export type IssuedInvite = {
  lease: Address;
  companyName: string;
  nameHash: string;
  agreedFee: string;
  /** Masked. The full address is never returned by any route. */
  email: string;
  expiresAt: number;
  delivery: { sender: string; sent: boolean };
  /**
   * The full invite link. Present **only in mock mode**, where the demo operator needs it and is the
   * only reader; in live mode the token reaches the appraiser by e-mail alone.
   */
  url?: string;
};

export type ClaimedInvite = { lease: Address; companyName: string; wallet: Address; claimedAt: number };

export type InviteDeps = {
  rpc: () => Rpc<GetAccountInfoApi>;
  log?: (...args: unknown[]) => void;
  sender?: EmailSender;
  now?: () => number;
  /** Test seam: the program id a lease and a dispute must be owned by. */
  program?: Address;
};

/**
 * `relstate/invite/v1/${authMode}` — its own HMAC key, so a session token is not an invite token
 * and vice versa, and mode-separated the same way `sessionSecret` is: a mock-minted invite token
 * must not verify on a live deployment sharing `SESSION_SECRET`.
 */
export const inviteSecret = (): Buffer => hmacSecret(`relstate/invite/v1/${env.authMode}`);

/** The invite link an e-mail carries, and the route oa-app has to serve. */
export const inviteUrl = (token: string, appUrl = env.appUrl): string => `${appUrl.replace(/\/$/, "")}/#/invite/${token}`;

/**
 * How long an invite may live. Defaults to the program's own `SELECTION_WINDOW_SECS`, which is the
 * window the invitation exists to fit inside; the issue path clamps the expiry to the dispute's
 * actual `selection_deadline` as well, so a link can never outlive the window in which the parties
 * could still bind the wallet it carries.
 */
export const inviteTtlSeconds = (): number => (env.invites.ttlSeconds !== "" ? Number(env.invites.ttlSeconds) : idlConstant("SELECTION_WINDOW_SECS"));

export function createInvites(deps: InviteDeps) {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => Date.now());
  const program = deps.program ?? (RELSTATE_PROGRAM as Address);
  const sender = deps.sender ?? createEmailSender({ log });

  const byId = new Map<string, InviteRecord>();
  /** One live invite per lease: issuing a new one replaces it, so invites cannot accumulate. */
  const idByLease = new Map<string, string>();

  const sweep = (): void => {
    const cutoff = Math.floor(now() / 1000);
    for (const [id, invite] of byId) {
      if (invite.expiresAt > cutoff) continue;
      byId.delete(id);
      if (idByLease.get(invite.lease) === id) idByLease.delete(invite.lease);
    }
  };

  const partyOf = (lease: DecodedLease, wallet: string): Party => {
    if (wallet === lease.landlord) return "landlord";
    if (wallet === lease.tenant) return "tenant";
    throw new InviteError("only the landlord or the tenant of this lease can do that", "not-a-party", 403);
  };

  const requireLeaseAddress = (value: unknown): Address => {
    if (typeof value !== "string" || !isAddress(value)) throw new InviteError("lease must be the lease account's address", "malformed-body");
    return value;
  };

  /** The lease, as a party of it. Both the party check and the on-chain read that makes it mean something. */
  async function leaseAsParty(lease: Address, wallet: string): Promise<{ lease: DecodedLease; party: Party }> {
    const decoded = await fetchLease(deps.rpc(), lease, program);
    return { lease: decoded, party: partyOf(decoded, wallet) };
  }

  const publicView = (invite: InviteRecord): PublicInviteView => ({
    lease: invite.lease,
    companyName: invite.companyName,
    nameHash: invite.nameHash,
    agreedFee: invite.agreedFee.toString(),
    mint: invite.mint,
    depositAmount: invite.depositAmount.toString(),
    landlord: invite.landlord,
    tenant: invite.tenant,
    selectionDeadline: invite.selectionDeadline,
    verdictWindowSecs: idlConstant("VERDICT_WINDOW_SECS"),
    status: invite.wallet === null ? "pending" : "claimed",
    claimedWallet: invite.wallet,
    expiresAt: invite.expiresAt,
  });

  const partyView = (invite: InviteRecord): PartyInviteView => ({
    companyName: invite.companyName,
    nameHash: invite.nameHash,
    agreedFee: invite.agreedFee.toString(),
    status: invite.wallet === null ? "pending" : "claimed",
    wallet: invite.wallet,
    claimedAt: invite.claimedAt,
    expiresAt: invite.expiresAt,
    issuedBy: invite.issuedBy,
  });

  /**
   * Verifies the token and finds its record.
   *
   * Both halves are required. The HMAC alone proves the token was minted here and has not expired;
   * the record is what makes it single-use and claimable. An unknown id is refused rather than
   * trusted — after a restart there is no record, so every outstanding invite is dead, which is the
   * safe direction. The token's own `lease`/`nameHash` claims are re-checked against the record, so
   * the binding holds even if the store were somehow re-keyed.
   */
  function resolve(token: unknown): InviteRecord {
    if (typeof token !== "string" || token === "") throw new InviteError("an invite token is required", "invite-invalid", 404);
    // AuthError carries "expired" vs "bad signature"; both are the same answer to a stranger.
    let claims: Record<string, unknown>;
    try {
      claims = verifyHmacToken(token, { secret: inviteSecret(), now: now(), what: "invite" });
    } catch (e) {
      throw new InviteError(e instanceof Error && /expired/.test(e.message) ? "this invitation has expired" : "this invitation is not valid", e instanceof Error && /expired/.test(e.message) ? "invite-expired" : "invite-invalid", 404);
    }
    const invite = typeof claims.i === "string" ? byId.get(claims.i) : undefined;
    if (invite === undefined) throw new InviteError("this invitation is no longer valid", "invite-invalid", 404);
    if (invite.lease !== claims.l || invite.nameHash !== claims.n) {
      throw new InviteError("this invitation is no longer valid", "invite-invalid", 404);
    }
    if (invite.expiresAt * 1000 <= now()) throw new InviteError("this invitation has expired", "invite-expired", 404);
    return invite;
  }

  return {
    /** For `/health` and the issue response. */
    senderName: sender.name,

    /**
     * `POST /api/invites` — a party invites the agreed company.
     *
     * Every check is on chain state read at this moment, not on anything the caller said: the
     * parties come off the `Lease`, the agreed name hash off the `Dispute`.
     */
    async issue({ lease: leaseInput, companyName, email, wallet }: { lease: unknown; companyName: unknown; email: unknown; wallet: string }): Promise<IssuedInvite> {
      sweep();
      const leaseAddress = requireLeaseAddress(leaseInput);
      if (typeof companyName !== "string") throw new InviteError("companyName is required", "malformed-body");
      if (typeof email !== "string" || !looksLikeEmail(email.trim())) {
        throw new InviteError("email must be one e-mail address", "malformed-body");
      }

      const { lease, party } = await leaseAsParty(leaseAddress, wallet);
      if (lease.status !== "mediation") {
        throw new InviteError(`this lease is ${lease.status}, not in mediation; there is nobody to invite yet`, "lease-not-in-mediation", 409);
      }
      const dispute = await fetchDispute(deps.rpc(), leaseAddress, program);
      if (dispute === null) throw new InviteError("this lease has no mediation account", "lease-not-in-mediation", 409);
      if (dispute.appraiser !== null) {
        throw new InviteError("an appraiser is already bound for this lease", "appraiser-already-bound", 409);
      }
      if (dispute.agreedNameHash === null) {
        throw new InviteError("the two parties have not agreed on a company yet, so there is nobody to invite", "name-not-agreed", 409);
      }

      let display: string;
      try {
        display = displayAppraiserName(companyName);
      } catch (e) {
        throw new InviteError(e instanceof InvalidAppraiserName ? e.message : String(e), "invalid-name");
      }
      const nameHash = appraiserNameHash(display);
      if (nameHash !== dispute.agreedNameHash) {
        throw new InviteError(`"${display}" is not the company the parties agreed on`, "name-mismatch", 409);
      }

      // Never past the selection deadline: after it, no wallet this invite produced could be bound
      // (`SelectionWindowClosed`), so an invite that outlived it would only mislead.
      const nowSeconds = Math.floor(now() / 1000);
      const expiresAt = Math.min(nowSeconds + inviteTtlSeconds(), dispute.selectionDeadline);
      if (expiresAt <= nowSeconds) {
        throw new InviteError("the selection window for this mediation has closed", "selection-window-closed", 409);
      }

      const id = randomUUID();
      const { token } = createHmacToken({ i: id, l: leaseAddress, n: nameHash }, { secret: inviteSecret(), ttlSeconds: expiresAt - nowSeconds, now: now() });
      const invite: InviteRecord = {
        id,
        lease: leaseAddress,
        companyName: display,
        nameHash,
        agreedFee: dispute.agreedFee,
        email: email.trim(),
        issuedBy: party,
        expiresAt,
        wallet: null,
        claimedAt: null,
        landlord: lease.landlord,
        tenant: lease.tenant,
        mint: lease.mint,
        depositAmount: lease.depositAmount,
        selectionDeadline: dispute.selectionDeadline,
      };

      // Replacing drops the previous token: a party who mistyped the address, or whose appraiser
      // claimed with the wrong wallet, re-issues and the old link stops working.
      const previous = idByLease.get(leaseAddress);
      if (previous !== undefined) byId.delete(previous);
      byId.set(id, invite);
      idByLease.set(leaseAddress, id);

      const url = inviteUrl(token);
      let sent = sender.delivers;
      try {
        await sender.send({
          to: invite.email,
          subject: `Appraisal request for lease ${leaseAddress}`,
          text:
            `${display},\n\n` +
            `The landlord and the tenant of lease ${leaseAddress} have both named your company to decide a disputed deposit.\n\n` +
            `Agreed fee: ${invite.agreedFee} base units of mint ${invite.mint}.\n` +
            `Deposit in dispute: ${invite.depositAmount} base units.\n\n` +
            `Open this link to accept and create the wallet you will sign the verdict with:\n${url}\n\n` +
            `The link is single-use and expires at ${new Date(expiresAt * 1000).toISOString()}.\n` +
            `Both parties must then confirm your wallet before you can submit a verdict.\n`,
          secrets: [token, url],
        });
      } catch (e) {
        // The invite exists either way: it is valid state, and a mail provider that is down must
        // not lose it. The party is told delivery failed and can re-issue or pass the link on.
        sent = false;
        log(`invite ${id}: ${sender.name} sender failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Who invited whom, for which lease. Never the token, and never the address in full.
      log(`invite ${id}: lease=${leaseAddress} company="${display}" to=${maskEmail(invite.email)} by=${party} sender=${sender.name} sent=${sent}`);

      return {
        lease: leaseAddress,
        companyName: display,
        nameHash,
        agreedFee: invite.agreedFee.toString(),
        email: maskEmail(invite.email),
        expiresAt,
        delivery: { sender: sender.name, sent },
        ...(env.mode === "mock" ? { url } : {}),
      };
    },

    /** `GET /api/invites/:token` — public. What the appraiser sees before they have a wallet. */
    read(token: unknown): PublicInviteView {
      sweep();
      return publicView(resolve(token));
    },

    /**
     * `POST /api/invites/:token/claim` — the appraiser binds the invite to their own session wallet.
     *
     * The wallet comes from the session and never from the body, so an appraiser cannot nominate
     * someone else's key, and a party cannot claim on the appraiser's behalf.
     */
    claim(token: unknown, wallet: Address): ClaimedInvite {
      sweep();
      const invite = resolve(token);
      if (invite.wallet !== null) {
        if (invite.wallet !== wallet) {
          throw new InviteError("this invitation has already been accepted by another wallet", "already-claimed", 409);
        }
        return { lease: invite.lease, companyName: invite.companyName, wallet: invite.wallet, claimedAt: invite.claimedAt ?? 0 };
      }
      // The program refuses a party wallet at propose, confirm and verdict (§10 item 4); refusing it
      // here turns an eventual on-chain `NotMediationParty` into an answer on the page that caused it.
      if (wallet === invite.landlord || wallet === invite.tenant) {
        throw new InviteError("a party to the lease cannot be its appraiser", "wallet-is-party", 409);
      }
      invite.wallet = wallet;
      invite.claimedAt = Math.floor(now() / 1000);
      log(`invite ${invite.id}: claimed lease=${invite.lease} wallet=${wallet}`);
      return { lease: invite.lease, companyName: invite.companyName, wallet, claimedAt: invite.claimedAt };
    },

    /**
     * `GET /api/invites?lease=…` — the pending appraiser wallet, for a party of that lease.
     *
     * This is how each side's app learns which pubkey to pass to `propose_appraiser_key` and
     * `confirm_appraiser_key`. Both parties see the same answer, which is the point: they are
     * agreeing about one wallet.
     */
    async pending({ lease: leaseInput, wallet }: { lease: unknown; wallet: string }): Promise<{ lease: Address; invite: PartyInviteView | null }> {
      sweep();
      const leaseAddress = requireLeaseAddress(leaseInput);
      await leaseAsParty(leaseAddress, wallet);
      const id = idByLease.get(leaseAddress);
      const invite = id === undefined ? undefined : byId.get(id);
      return { lease: leaseAddress, invite: invite === undefined ? null : partyView(invite) };
    },

    /** Test seam: how many invites are live. */
    size: (): number => {
      sweep();
      return byId.size;
    },
  };
}

export type Invites = ReturnType<typeof createInvites>;
