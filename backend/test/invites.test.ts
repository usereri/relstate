import "./noenv.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { generateKeyPairSigner, getAddressEncoder, getBase64Decoder, type Address } from "@solana/kit";
import { RELSTATE_PROGRAM } from "../src/contracts.ts";
import { appraiserNameHash, disputePda } from "../src/dispute.ts";
import { createInvites, inviteSecret } from "../src/invites.ts";
import { accountLayout, type Layout } from "../src/layout.ts";
import { LEASE_STATUS } from "../src/lease.ts";

// A fake chain: one Lease and one Dispute, built byte-exactly from the layouts the IDL gives, so
// these tests exercise the real decoders rather than a stub of them.

const PROGRAM = RELSTATE_PROGRAM as Address;
const addresses = getAddressEncoder();
const discriminator = (name: string) => new Uint8Array(createHash("sha256").update(`account:${name}`).digest().subarray(0, 8));

type LeaseFields = { landlord: Address; tenant: Address; mint: Address; deposit: bigint; status: string };

function encodeLease(fields: LeaseFields, layout: Layout = accountLayout("Lease")): Uint8Array {
  const data = new Uint8Array(layout.size);
  const view = new DataView(data.buffer);
  data.set(discriminator("Lease"), 0);
  for (const [field, address] of [["landlord", fields.landlord], ["tenant", fields.tenant], ["mint", fields.mint]] as const) {
    data.set(addresses.encode(address), layout.offsets[field]!);
  }
  view.setBigUint64(layout.offsets.deposit_amount!, fields.deposit, true);
  data[layout.offsets.status!] = LEASE_STATUS.indexOf(fields.status as never);
  return data;
}

type DisputeFields = {
  lease: Address;
  agreedNameHash?: string;
  agreedFee?: bigint;
  appraiser?: Address;
  selectionDeadline: number;
  candidates?: { name: string; fee: bigint }[];
};

function encodeDispute(fields: DisputeFields, layout: Layout = accountLayout("Dispute")): Uint8Array {
  const data = new Uint8Array(layout.size);
  const view = new DataView(data.buffer);
  data.set(discriminator("Dispute"), 0);
  data.set(addresses.encode(fields.lease), layout.offsets.lease!);
  if (fields.agreedNameHash !== undefined) data.set(Buffer.from(fields.agreedNameHash, "hex"), layout.offsets.agreed_name_hash!);
  view.setBigUint64(layout.offsets.agreed_fee!, fields.agreedFee ?? 0n, true);
  if (fields.appraiser !== undefined) data.set(addresses.encode(fields.appraiser), layout.offsets.appraiser!);
  view.setBigInt64(layout.offsets.selection_deadline!, BigInt(fields.selectionDeadline), true);
  // The landlord's candidate list, so the `Candidate` decode is exercised on real bytes.
  const stride = (layout.offsets.tenant_candidates! - layout.offsets.landlord_candidates!) / 3;
  const nameLimit = stride - 41;
  (fields.candidates ?? []).forEach((candidate, i) => {
    const at = layout.offsets.landlord_candidates! + i * stride;
    const bytes = Buffer.from(candidate.name, "utf8");
    data.set(bytes, at);
    data[at + nameLimit] = bytes.length;
    data.set(Buffer.from(appraiserNameHash(candidate.name), "hex"), at + nameLimit + 1);
    view.setBigUint64(at + nameLimit + 33, candidate.fee, true);
  });
  data[layout.offsets.landlord_count!] = (fields.candidates ?? []).length;
  return data;
}

const COMPANY = "Acme Wycena";

async function fixture(options: { status?: string; agreed?: boolean; bound?: boolean; selectionIn?: number; now?: number } = {}) {
  const [landlord, tenant, appraiser, stranger] = (await Promise.all([0, 1, 2, 3].map(async () => (await generateKeyPairSigner()).address))) as [Address, Address, Address, Address];
  const lease = (await generateKeyPairSigner()).address;
  const nowMs = options.now ?? Date.UTC(2026, 0, 1);
  const now = () => nowMs;
  const selectionDeadline = Math.floor(nowMs / 1000) + (options.selectionIn ?? 3600);
  const dispute = await disputePda(lease);
  const accounts = new Map<string, { data: Uint8Array; owner: Address }>([
    [lease, { data: encodeLease({ landlord, tenant, mint: landlord, deposit: 10_000_000n, status: options.status ?? "mediation" }), owner: PROGRAM }],
  ]);
  if (options.status !== "no-dispute") {
    accounts.set(dispute, {
      data: encodeDispute({
        lease,
        agreedNameHash: options.agreed === false ? undefined : appraiserNameHash(COMPANY),
        agreedFee: 500_000n,
        appraiser: options.bound ? appraiser : undefined,
        selectionDeadline,
        candidates: [{ name: COMPANY, fee: 500_000n }],
      }),
      owner: PROGRAM,
    });
  }
  const sent: { to: string; text: string }[] = [];
  const rpc = {
    getAccountInfo: (address: Address) => ({
      send: async () => {
        const account = accounts.get(address);
        return { context: { slot: 1n }, value: account === undefined ? null : { owner: account.owner, data: [getBase64Decoder().decode(account.data), "base64"] } };
      },
    }),
  };
  const invites = createInvites({
    rpc: () => rpc as never,
    now,
    program: PROGRAM,
    sender: { name: "test", delivers: true, send: async (email) => void sent.push({ to: email.to, text: email.text }) },
  });
  return { invites, lease, landlord, tenant, appraiser, stranger, sent, selectionDeadline, nowSeconds: Math.floor(nowMs / 1000) };
}

const codeOf = async (fn: () => unknown): Promise<string | undefined> => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    assert.ok(e instanceof Error && "code" in e, `expected an InviteError, got ${String(e)}`);
    return (e as { code: string }).code;
  }
};

/** The token out of the mock-mode url the issue response carries. */
const tokenOf = (url: string | undefined): string => {
  assert.ok(url !== undefined, "the issue response should carry a url in mock mode");
  return url.slice(url.lastIndexOf("/") + 1);
};

describe("POST /api/invites", () => {
  it("issues for the agreed company, to a party, and never echoes the e-mail", async () => {
    const f = await fixture();
    const issued = await f.invites.issue({ lease: f.lease, companyName: "  acme   WYCENA ", email: "biuro@acme.example", wallet: f.landlord });
    // Canonicalisation and case folding are the program's, so the hash matches what is on chain.
    assert.equal(issued.companyName, "acme WYCENA");
    assert.equal(issued.nameHash, appraiserNameHash(COMPANY));
    assert.equal(issued.agreedFee, "500000");
    assert.equal(issued.email, "b***@acme.example");
    assert.equal(JSON.stringify(issued).includes("biuro@acme.example"), false, "the full address must not appear anywhere in the response");
    assert.deepEqual(issued.delivery, { sender: "test", sent: true });
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]?.to, "biuro@acme.example");
  });

  it("refuses a stranger, a lease that is not in mediation, and a name the parties did not agree", async () => {
    const f = await fixture();
    assert.equal(await codeOf(() => f.invites.issue({ lease: f.lease, companyName: COMPANY, email: "a@b.example", wallet: f.stranger })), "not-a-party");
    assert.equal(await codeOf(() => f.invites.issue({ lease: f.lease, companyName: "Other Firm", email: "a@b.example", wallet: f.tenant })), "name-mismatch");

    const active = await fixture({ status: "active" });
    assert.equal(await codeOf(() => active.invites.issue({ lease: active.lease, companyName: COMPANY, email: "a@b.example", wallet: active.landlord })), "lease-not-in-mediation");

    const unagreed = await fixture({ agreed: false });
    assert.equal(await codeOf(() => unagreed.invites.issue({ lease: unagreed.lease, companyName: COMPANY, email: "a@b.example", wallet: unagreed.landlord })), "name-not-agreed");

    const bound = await fixture({ bound: true });
    assert.equal(await codeOf(() => bound.invites.issue({ lease: bound.lease, companyName: COMPANY, email: "a@b.example", wallet: bound.landlord })), "appraiser-already-bound");
  });

  it("refuses an invisible character in the name, as the program does", async () => {
    const f = await fixture();
    assert.equal(await codeOf(() => f.invites.issue({ lease: f.lease, companyName: "Acme​ Wycena", email: "a@b.example", wallet: f.landlord })), "invalid-name");
  });

  it("refuses a variation selector in the name (S1: parity with the program's is_invisible)", async () => {
    const f = await fixture();
    assert.equal(await codeOf(() => f.invites.issue({ lease: f.lease, companyName: "Acme\u{FE0F} Wycena", email: "a@b.example", wallet: f.landlord })), "invalid-name");
  });

  it("refuses something that is not an e-mail address", async () => {
    const f = await fixture();
    for (const email of ["", "   ", f.landlord, "a@b", "two@a.example,three@b.example"]) {
      assert.equal(await codeOf(() => f.invites.issue({ lease: f.lease, companyName: COMPANY, email, wallet: f.landlord })), "malformed-body", `${email} should be refused`);
    }
  });

  it("never expires after the selection deadline, even when the TTL is longer", async () => {
    const f = await fixture({ selectionIn: 30 });
    const issued = await f.invites.issue({ lease: f.lease, companyName: COMPANY, email: "a@b.example", wallet: f.landlord });
    assert.equal(issued.expiresAt, f.selectionDeadline, "the expiry must be clamped to selection_deadline");
  });

  it("refuses to issue once the selection window has closed", async () => {
    const f = await fixture({ selectionIn: 0 });
    assert.equal(await codeOf(() => f.invites.issue({ lease: f.lease, companyName: COMPANY, email: "a@b.example", wallet: f.landlord })), "selection-window-closed");
  });

  it("re-issuing replaces the previous invite and kills its token", async () => {
    const f = await fixture();
    const first = await f.invites.issue({ lease: f.lease, companyName: COMPANY, email: "typo@acme.example", wallet: f.landlord });
    const second = await f.invites.issue({ lease: f.lease, companyName: COMPANY, email: "biuro@acme.example", wallet: f.tenant });
    assert.equal(f.invites.size(), 1, "only the latest invite for a lease is live");
    assert.equal(await codeOf(() => f.invites.read(tokenOf(first.url))), "invite-invalid");
    assert.doesNotThrow(() => f.invites.read(tokenOf(second.url)));
  });
});

describe("GET /api/invites/:token", () => {
  it("shows the appraiser what they need and nothing about the parties' e-mail", async () => {
    const f = await fixture();
    const issued = await f.invites.issue({ lease: f.lease, companyName: COMPANY, email: "biuro@acme.example", wallet: f.landlord });
    const view = f.invites.read(tokenOf(issued.url));
    assert.equal(view.lease, f.lease);
    assert.equal(view.companyName, COMPANY);
    assert.equal(view.agreedFee, "500000");
    assert.equal(view.depositAmount, "10000000");
    assert.equal(view.landlord, f.landlord);
    assert.equal(view.tenant, f.tenant);
    assert.equal(view.status, "pending");
    assert.equal(view.claimedWallet, null);
    assert.equal(JSON.stringify(view).includes("acme.example"), false, "no e-mail address may reach the public view");
  });

  it("refuses a forged, an unknown and an expired token", async () => {
    const f = await fixture();
    const issued = await f.invites.issue({ lease: f.lease, companyName: COMPANY, email: "a@b.example", wallet: f.landlord });
    const token = tokenOf(issued.url);
    assert.equal(await codeOf(() => f.invites.read("")), "invite-invalid");
    assert.equal(await codeOf(() => f.invites.read("not.atoken")), "invite-invalid");
    // A valid-looking token signed with the wrong key.
    const [payload] = token.split(".");
    assert.equal(await codeOf(() => f.invites.read(`${payload}.${Buffer.from("x".repeat(32)).toString("base64url")}`)), "invite-invalid");

    // Past its expiry the token says so, which is a more useful answer than "invalid" and gives
    // nothing away: the signature was already proved good before the clock was looked at.
    const later = await fixture({ selectionIn: 10 });
    const soon = await later.invites.issue({ lease: later.lease, companyName: COMPANY, email: "a@b.example", wallet: later.landlord });
    const expired = createInvites({ rpc: () => ({}) as never, now: () => (soon.expiresAt + 1) * 1000, program: PROGRAM });
    assert.equal(await codeOf(() => expired.read(tokenOf(soon.url))), "invite-expired");
    assert.equal(await codeOf(() => expired.claim(tokenOf(soon.url), f.appraiser)), "invite-expired", "an expired invite cannot be claimed");
  });

  it("a restart invalidates outstanding invites rather than honouring an unknown one", async () => {
    const f = await fixture();
    const issued = await f.invites.issue({ lease: f.lease, companyName: COMPANY, email: "a@b.example", wallet: f.landlord });
    // Same secret (same process), unexpired token, but a store that never saw it: fail closed.
    const restarted = createInvites({ rpc: () => ({}) as never, now: () => f.nowSeconds * 1000, program: PROGRAM });
    assert.equal(await codeOf(() => restarted.read(tokenOf(issued.url))), "invite-invalid");
  });

  it("does not consume the invite: the page can be opened before signing in", async () => {
    const f = await fixture();
    const issued = await f.invites.issue({ lease: f.lease, companyName: COMPANY, email: "a@b.example", wallet: f.landlord });
    const token = tokenOf(issued.url);
    f.invites.read(token);
    f.invites.read(token);
    assert.equal(f.invites.claim(token, f.appraiser).wallet, f.appraiser);
  });
});

describe("POST /api/invites/:token/claim", () => {
  it("binds the invite to the session's own wallet, idempotently", async () => {
    const f = await fixture();
    const issued = await f.invites.issue({ lease: f.lease, companyName: COMPANY, email: "a@b.example", wallet: f.landlord });
    const token = tokenOf(issued.url);
    const claimed = f.invites.claim(token, f.appraiser);
    assert.deepEqual({ lease: claimed.lease, wallet: claimed.wallet, companyName: claimed.companyName }, { lease: f.lease, wallet: f.appraiser, companyName: COMPANY });
    assert.deepEqual(f.invites.claim(token, f.appraiser), claimed, "the same wallet claiming twice is idempotent");
    assert.equal(f.invites.read(token).status, "claimed");
  });

  it("refuses a second wallet, and refuses a party to the lease", async () => {
    const f = await fixture();
    const issued = await f.invites.issue({ lease: f.lease, companyName: COMPANY, email: "a@b.example", wallet: f.landlord });
    const token = tokenOf(issued.url);
    assert.equal(await codeOf(() => f.invites.claim(token, f.landlord)), "wallet-is-party");
    assert.equal(await codeOf(() => f.invites.claim(token, f.tenant)), "wallet-is-party");
    f.invites.claim(token, f.appraiser);
    assert.equal(await codeOf(() => f.invites.claim(token, f.stranger)), "already-claimed");
    assert.equal(f.invites.read(token).claimedWallet, f.appraiser, "a refused claim must not overwrite the wallet");
  });
});

describe("GET /api/invites?lease=…", () => {
  it("gives both parties the same wallet to confirm, and neither an e-mail", async () => {
    const f = await fixture();
    const issued = await f.invites.issue({ lease: f.lease, companyName: COMPANY, email: "biuro@acme.example", wallet: f.landlord });
    f.invites.claim(tokenOf(issued.url), f.appraiser);
    const asLandlord = await f.invites.pending({ lease: f.lease, wallet: f.landlord });
    const asTenant = await f.invites.pending({ lease: f.lease, wallet: f.tenant });
    assert.deepEqual(asLandlord, asTenant, "the two parties must be agreeing about one wallet");
    assert.equal(asLandlord.invite?.wallet, f.appraiser);
    assert.equal(asLandlord.invite?.issuedBy, "landlord");
    assert.equal(JSON.stringify(asLandlord).includes("acme.example"), false);
  });

  it("refuses a stranger and reports null when nothing was issued", async () => {
    const f = await fixture();
    assert.equal(await codeOf(() => f.invites.pending({ lease: f.lease, wallet: f.stranger })), "not-a-party");
    assert.deepEqual(await f.invites.pending({ lease: f.lease, wallet: f.tenant }), { lease: f.lease, invite: null });
  });
});

describe("the invite token is not a session token", () => {
  it("has its own HMAC key", async () => {
    const { sessionSecret } = await import("../src/auth.ts");
    assert.notDeepEqual(inviteSecret(), sessionSecret(), "an invite token signed with the session key would be a session token");
  });

  it("the invite HMAC domain is mode-separated, like the session one (S4a)", async () => {
    const { env } = await import("../src/env.ts");
    const original = env.authMode;
    try {
      (env as unknown as { authMode: string }).authMode = "mock";
      const mockSecret = inviteSecret();
      (env as unknown as { authMode: string }).authMode = "wallet";
      const walletSecret = inviteSecret();
      assert.notDeepEqual(mockSecret, walletSecret, "a mock-minted invite token must not verify on a live (wallet-mode) deployment");
    } finally {
      (env as unknown as { authMode: string }).authMode = original;
    }
  });
});
