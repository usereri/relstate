// The KYC service: what happens between "the tenant pressed Verify" and "there is an attestation
// on chain for their wallet" (docs/contracts/attestation.md).
//
// Trust model, which is the only interesting thing in this file:
//
//   * the browser can ask for a verification link and nothing else. It cannot say it passed;
//   * the decision comes from the vendor's signed webhook, and the *wallet* comes from the
//     session that asked for the link — never from the webhook's request body;
//   * one vendor event attests at most once, keyed on the vendor's own event id, because
//     providers retry deliveries;
//   * the attestation is signed by the **issuer key**, which is not the fee payer key. The fee
//     payer only funds the account's rent;
//   * no personal data is stored or logged. The link back to the applicant is
//     `sha256(applicantId || salt)` with a salt that stays in this process.
//
// The mock provider goes through the same path: its page resolves a server-side session created
// under the caller's session token, so even the mock never learns whose wallet to verify from the
// page that confirms it.
import { isAddress, type Address } from "@solana/kit";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AttestationView, Provider, ProviderEvent } from "../contracts.ts";
import type { AttestationAccount, AttestationChain, KycPolicy } from "./kyc-chain.ts";
import { isValid } from "./kyc-chain.ts";
import { jsonForScript } from "./onramp.ts";
import { WebhookError } from "./stripe.ts";
import { createSumsubKyc, type SumsubConfig } from "./kyc-sumsub.ts";

export { WebhookError };

/** What a KYC provider hands back: `ProviderEvent` plus the parts only identity cares about. */
export type KycProviderEvent = ProviderEvent & {
  /** The vendor's applicant id. Pseudonymous, and hashed with a secret salt before it is stored. */
  applicantId: string;
  /** The vendor's verification level name, for the log line. Never decides the on-chain level. */
  levelName?: string;
  /** Why a check was refused, as the vendor's own code (e.g. `FINAL`). Never free text about a person. */
  reason?: string;
};

export class KycError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 429 | 503;
  constructor(message: string, code: string, status: 400 | 404 | 429 | 503 = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * This deployment cannot write attestations at all: no issuer key, a throwaway fee payer that
 * cannot pay for the account, or no reachable RPC. Distinct from a failed write, because no
 * amount of retrying fixes it — the screens say so instead, and the flow still demonstrates.
 */
export class KycUnavailable extends KycError {
  constructor(message: string) {
    super(message, "kyc-unavailable", 503);
  }
}

/** A verification the user started. Priced — in the identity sense — server-side before the page opens. */
export type KycSession = {
  id: string;
  wallet: string;
  provider: "mock" | "sumsub";
  createdAt: number;
};

/**
 * What one webhook did. Deliberately small: a decision, what was written on chain, and when.
 *
 * `subjectHash` is in here because it is what went on chain and is useful on stage; it is a hash
 * with a secret salt, not a personal datum. Nothing else about the applicant is kept.
 */
export type KycRecord = {
  /** The vendor's event id: the idempotency key for the whole record. */
  ref: string;
  wallet: string;
  decision: "approved" | "rejected";
  status: "attested" | "revoked" | "nothing-to-revoke" | "not-written";
  level?: number;
  /** Unix seconds; 0 means never. */
  expiresAt?: number;
  subjectHash?: string;
  attestation?: string;
  signatures: string[];
  reason?: string;
  at: number;
};

export type KycStart = {
  /** Hosted page (mock, or Sumsub's WebSDK link). */
  url: string;
  session: string;
  provider: "mock" | "sumsub";
  /** True in mock mode: no vendor, no documents, the page decides instantly. */
  simulated: boolean;
  /** The level an approval will write on chain. */
  level: number;
  /** Unix seconds an approval would expire at, or 0 for never. Shown before the user starts. */
  expiresAt: number;
};

export type KycStatus = {
  wallet: string;
  /** The answer the app acts on: a valid attestation exists for this wallet. */
  verified: boolean;
  /** Whether the program is currently gating `apply` / `propose_lease` on it. */
  requireKyc: boolean;
  /** The issuer the program accepts, or null when the config has none / could not be read. */
  issuer: string | null;
  attestation: AttestationView | null;
  /** A session has been started and no final webhook has landed for it yet. */
  pending: boolean;
  /** The last webhook for this wallet, if any. */
  last: KycRecord | null;
  provider: "mock" | "sumsub";
  /** Set when this deployment cannot write attestations at all (no issuer key, no RPC). */
  unavailable?: string;
};

export type KycConfig = {
  provider: "mock" | "sumsub";
  /** The level an approved check writes: 1 basic, 2 enhanced. */
  level: number;
  /** Attestation lifetime in days; 0 writes a never-expiring attestation. */
  validityDays: number;
  /**
   * Secret salt for `subject_hash`. Without it the hash would be a plain `sha256(applicantId)`,
   * which anyone holding a list of applicant ids could confirm against the chain.
   */
  subjectSalt: string;
  /** Verification links one wallet may start per hour. */
  maxStartsPerWalletPerHour?: number;
  /** Absolute base URL of this backend, for the mock page. */
  backendUrl: string;
  /** Absolute base URL of the app, for the hosted page's return. */
  appUrl: string;
  /** Required when `provider` is `sumsub`; `assertEnvConsistent` refuses the half-configured case. */
  sumsub?: SumsubConfig;
};

export type KycDeps = {
  config: KycConfig;
  /**
   * Resolved lazily, and allowed to throw `KycUnavailable`: a deployment with no issuer key can
   * still serve the screens and say honestly that nothing will be written.
   */
  chain: () => Promise<AttestationChain>;
  provider?: Provider;
  log?: (...args: unknown[]) => void;
  now?: () => number;
};

export const DAY_SECONDS = 86_400;

/**
 * The no-secrets provider. `start` points at a page this backend serves; that page posts the
 * session id back through the real webhook route, and the wallet is read from the stored session
 * rather than from the page's request.
 */
export function createMockKyc(deps: { session: (id: string) => KycSession | undefined; backendUrl: string }): Provider {
  return {
    async start(_wallet: string, opts: Record<string, unknown> = {}) {
      const session = String(opts.session ?? "");
      const back = String(opts.returnBase ?? "");
      return { url: `${deps.backendUrl}/mock/kyc?session=${encodeURIComponent(session)}&back=${encodeURIComponent(back)}` };
    },
    async webhook(_headers: Record<string, string>, rawBody: string): Promise<KycProviderEvent> {
      let body: { session?: unknown; decision?: unknown };
      try {
        body = JSON.parse(rawBody) as typeof body;
      } catch {
        throw new WebhookError("mock webhook body is not JSON", "body-malformed");
      }
      if (typeof body.session !== "string" || body.session === "") {
        throw new WebhookError("mock webhook needs { session }", "body-malformed");
      }
      const decision = body.decision === "decline" ? "decline" : "approve";
      const session = deps.session(body.session);
      if (session === undefined) throw new WebhookError(`unknown verification session ${body.session}`, "session-unknown");
      return {
        kind: decision === "approve" ? "kyc.approved" : "kyc.rejected",
        wallet: session.wallet,
        // The session id, so confirming the same mock check twice is the same event twice.
        ref: `mock-${session.id}-${decision}`,
        applicantId: `mock-applicant-${session.id}`,
        reason: decision === "decline" ? "SIMULATED" : undefined,
      };
    },
  };
}

export function createKyc(deps: KycDeps) {
  const { config } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;

  const sessions = new Map<string, KycSession>();
  const records = new Map<string, KycRecord>();
  const lastByWallet = new Map<string, string>();
  const openSessionByWallet = new Map<string, string>();
  const startsByWallet = new Map<string, number[]>();
  const HOUR_MS = 3_600_000;
  /** In flight by ref: a provider that retries before we answer must not attest twice. */
  const inFlight = new Map<string, Promise<KycRecord>>();

  /**
   * Without a configured salt, a random one for this process. Hashes then stop being comparable
   * across restarts, which is fine for a demo and wrong for anything else — so `assertEnvConsistent`
   * requires `KYC_SUBJECT_SALT` in live mode and this says so out loud.
   */
  const salt =
    config.subjectSalt !== ""
      ? config.subjectSalt
      : (() => {
          const generated = randomBytes(32).toString("base64");
          log("kyc: KYC_SUBJECT_SALT is not set; using a throwaway salt, so subject hashes will not survive a restart");
          return generated;
        })();

  // Never fail open to the click-to-approve provider: a config that says sumsub and carries no
  // Sumsub block is a bug, and the identity provider is the one place a fallback is wrong.
  if (deps.provider === undefined && config.provider === "sumsub" && config.sumsub === undefined) {
    throw new Error("KycConfig names the sumsub provider but has no sumsub settings; refusing to fall back to the mock verifier");
  }
  const provider: Provider =
    deps.provider ??
    (config.provider === "sumsub" && config.sumsub !== undefined
      ? createSumsubKyc(config.sumsub, { log, now })
      : createMockKyc({ session: (id) => sessions.get(id), backendUrl: config.backendUrl }));

  /** `sha256(applicantId || salt)`: the only link between a wallet on chain and a person at the vendor. */
  const subjectHash = (applicantId: string): Uint8Array =>
    new Uint8Array(createHash("sha256").update(applicantId, "utf8").update(salt, "utf8").digest());

  const expiryFrom = (atMs: number): number => (config.validityDays <= 0 ? 0 : Math.floor(atMs / 1000) + config.validityDays * DAY_SECONDS);

  /**
   * Starts a verification for the session's wallet.
   *
   * `wallet` comes from the session token, never from the body: it is what the webhook will read
   * back out of the vendor's event to decide whose attestation to write.
   */
  async function start({ wallet }: { wallet: string }): Promise<KycStart> {
    if (!isAddress(wallet)) throw new KycError(`${wallet} is not a valid wallet address`, "malformed-wallet");

    // Each start costs a vendor API call in sumsub mode, so one session cannot burn the quota.
    const limit = config.maxStartsPerWalletPerHour ?? 10;
    const recent = (startsByWallet.get(wallet) ?? []).filter((t) => now() - t < HOUR_MS);
    if (recent.length >= limit) {
      startsByWallet.set(wallet, recent);
      throw new KycError(`at most ${limit} verification starts per hour for one wallet`, "rate-limited", 429);
    }
    // Sessions are only useful while a check is in flight; drop the stale ones.
    for (const [id, s] of sessions) if (now() - s.createdAt > 24 * HOUR_MS) sessions.delete(id);

    const session: KycSession = { id: randomUUID(), wallet, provider: config.provider, createdAt: now() };
    // The app is a hash router, so the return path lives inside the fragment.
    const returnBase = `${config.appUrl}/#/app?tab=identity&kyc=`;
    const { url } = await provider.start(wallet, {
      session: session.id,
      returnBase,
      successUrl: `${returnBase}done&session=${session.id}`,
      cancelUrl: `${returnBase}cancelled&session=${session.id}`,
    });
    if (url === undefined || url === "") throw new KycError("the KYC provider returned no verification URL", "provider-no-url", 503);

    startsByWallet.set(wallet, [...recent, now()]);
    sessions.set(session.id, session);
    openSessionByWallet.set(wallet, session.id);
    log(`kyc: session ${session.id} started for ${wallet} (${config.provider})`);
    return {
      url,
      session: session.id,
      provider: config.provider,
      simulated: config.provider === "mock",
      level: config.level,
      expiresAt: expiryFrom(now()),
    };
  }

  /**
   * The only trusted trigger. Verifies the vendor's signature, then acts at most once per event id.
   *
   * A duplicate delivery returns the first record verbatim rather than writing again; a delivery
   * that arrives while the first is still running waits on it, because the vendor's retry timer
   * does not care that we are mid-transaction. A *failed* chain write is deliberately not
   * recorded, so a retry can try again — an identity that should be attested and is not is worth
   * retrying, unlike a credit that has already been taken.
   */
  async function handleWebhook(headers: Record<string, string>, rawBody: string): Promise<{ record: KycRecord; replay: boolean }> {
    const event = (await provider.webhook(headers, rawBody)) as KycProviderEvent;
    if (event.kind !== "kyc.approved" && event.kind !== "kyc.rejected") {
      throw new WebhookError(`ignoring ${event.kind}`, "event-ignored");
    }
    if (event.ref === "") throw new WebhookError("provider event has no reference; cannot make the attestation idempotent", "ref-missing");

    const existing = records.get(event.ref);
    if (existing !== undefined) {
      log(`kyc: event ${event.ref} already ${existing.status}; not writing again`);
      return { record: existing, replay: true };
    }
    const running = inFlight.get(event.ref);
    if (running !== undefined) return { record: await running, replay: true };

    const promise = applyEvent(event).finally(() => inFlight.delete(event.ref));
    inFlight.set(event.ref, promise);
    return { record: await promise, replay: false };
  }

  async function applyEvent(event: KycProviderEvent): Promise<KycRecord> {
    const at = now();
    const base = { ref: event.ref, wallet: event.wallet, signatures: [] as string[], at };
    const keep = (record: KycRecord): KycRecord => {
      records.set(record.ref, record);
      lastByWallet.set(record.wallet, record.ref);
      if (openSessionByWallet.get(record.wallet) !== undefined) openSessionByWallet.delete(record.wallet);
      return record;
    };
    const decision = event.kind === "kyc.approved" ? "approved" : "rejected";

    if (!isAddress(event.wallet)) {
      // Not an attack on anything — the wallet came from our own metadata — but the chain write
      // would fail on a bad address, and a vendor retry would fail the same way.
      log(`kyc: event ${event.ref} names ${event.wallet}, which is not an address; nothing written`);
      return keep({ ...base, decision, status: "not-written", reason: `${event.wallet} is not a valid wallet address` });
    }

    let chain: AttestationChain;
    try {
      chain = await deps.chain();
    } catch (error) {
      if (!(error instanceof KycUnavailable)) throw error;
      // No retry would fix this, so the record is final. The flow still completes in the UI,
      // labelled honestly.
      log(`kyc: event ${event.ref} ${decision}, but nothing was written: ${error.message}`);
      return keep({ ...base, decision, status: "not-written", reason: error.message });
    }

    const wallet = event.wallet as Address;
    if (decision === "rejected") {
      // Only revoke what exists: a first-time applicant who fails has no attestation, and
      // `revoke` on a missing account would fail the webhook for no reason.
      const current = await chain.read(wallet);
      if (current === null) {
        log(`kyc: ${wallet} was refused (${event.reason ?? "no reason given"}); nothing to revoke`);
        return keep({ ...base, decision, status: "nothing-to-revoke", reason: event.reason });
      }
      const { signatures } = await chain.revoke(wallet);
      return keep({ ...base, decision, status: "revoked", reason: event.reason, signatures: signatures.map(String) });
    }

    const hash = subjectHash(event.applicantId);
    const expiresAt = expiryFrom(at);
    const { signatures, attestation } = await chain.attest({ wallet, level: config.level, expiresAt, subjectHash: hash });
    // The applicant id is never logged: the hash is the only form of it this backend keeps.
    log(`kyc: ${wallet} verified at level ${config.level}${event.levelName === undefined ? "" : ` (${event.levelName})`}`);
    return keep({
      ...base,
      decision,
      status: "attested",
      level: config.level,
      expiresAt,
      subjectHash: Buffer.from(hash).toString("hex"),
      attestation,
      signatures: signatures.map(String),
    });
  }

  /** Reads the chain, which is the only source of truth for "verified". */
  async function status(wallet: string): Promise<KycStatus> {
    if (!isAddress(wallet)) throw new KycError(`${wallet} is not a valid wallet address`, "malformed-wallet");
    const ref = lastByWallet.get(wallet);
    const last = ref === undefined ? null : (records.get(ref) ?? null);
    const pending = openSessionByWallet.get(wallet) !== undefined;

    let chain: AttestationChain;
    try {
      chain = await deps.chain();
    } catch (error) {
      if (!(error instanceof KycUnavailable)) throw error;
      return {
        wallet,
        verified: false,
        requireKyc: false,
        issuer: null,
        attestation: null,
        pending,
        last,
        provider: config.provider,
        unavailable: error.message,
      };
    }

    const [attestation, policy] = await Promise.all([chain.read(wallet as Address), chain.policy()]);
    return {
      wallet,
      verified: isValid(attestation, policy, Math.floor(now() / 1000), wallet as Address),
      requireKyc: policy?.requireKyc ?? false,
      issuer: policy === null ? null : policy.issuer,
      attestation: attestation === null ? null : asView(attestation),
      pending,
      last,
      provider: config.provider,
    };
  }

  return {
    provider: config.provider,
    level: config.level,
    validityDays: config.validityDays,
    start,
    handleWebhook,
    status,
    session: (id: string): KycSession | undefined => sessions.get(id),
    record: (ref: string): KycRecord | undefined => records.get(ref),
  };
}

export type Kyc = ReturnType<typeof createKyc>;

/** The on-chain account as the app's contract describes it. */
export const asView = (a: AttestationAccount): AttestationView => ({
  wallet: a.wallet,
  level: (a.level === 2 ? 2 : a.level === 1 ? 1 : 0) as 0 | 1 | 2,
  verifiedAt: a.verifiedAt,
  expiresAt: a.expiresAt,
  revoked: a.revoked,
  subjectHash: a.subjectHash,
  issuer: a.issuer,
});

/** Re-exported so the route and the tests agree on what "valid" means without reaching into the chain module. */
export type { AttestationAccount, KycPolicy };

/**
 * The no-secrets verification page: collects what a real check would collect, decides instantly,
 * and sends nothing about the person anywhere.
 *
 * The name field is real in the sense that it behaves like the vendor's form — and it is never
 * submitted. The page says so, because that is exactly the claim the demo makes about the real
 * thing: personal data stays with the vendor, the chain and this backend see a hash and a level.
 */
export function mockVerificationPage(session: KycSession, back: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulated identity check · Relstate</title>
<style>
  :root { color-scheme: light dark; --ink:#1b1714; --paper:#faf7f2; --line:#e4dbcf; --brand:#1d5f6c; }
  @media (prefers-color-scheme: dark) { :root { --ink:#f3efe9; --paper:#17140f; --line:#352e26; } }
  body { margin:0; min-height:100dvh; display:grid; place-items:center; background:var(--paper); color:var(--ink);
         font:16px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; padding:24px; }
  .card { width:100%; max-width:26rem; background:color-mix(in srgb, var(--paper) 88%, white); border:1px solid var(--line);
          border-radius:20px; padding:28px; box-shadow:0 20px 40px -28px rgba(0,0,0,.35); }
  h1 { font-size:1.35rem; margin:0 0 4px; }
  .tag { display:inline-block; font-size:.72rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase;
         background:#f3e1c2; color:#7a4a14; border-radius:999px; padding:4px 10px; margin-bottom:14px; }
  label { display:block; font-size:.8rem; font-weight:600; margin:16px 0 6px; }
  input { width:100%; box-sizing:border-box; min-height:46px; padding:0 12px; border:1px solid var(--line); border-radius:12px;
          background:var(--paper); color:inherit; font:inherit; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:8px 16px; margin:18px 0; font-variant-numeric:tabular-nums; }
  dt { color:color-mix(in srgb, var(--ink) 60%, transparent); } dd { margin:0; text-align:right; font-weight:600; }
  code { font-size:.8rem; word-break:break-all; font-weight:400; }
  button { width:100%; min-height:48px; border:0; border-radius:14px; background:var(--brand); color:#fff;
           font:inherit; font-weight:600; cursor:pointer; margin-top:16px; }
  button.ghost { background:transparent; color:inherit; border:1px solid var(--line); margin-top:8px; }
  button:disabled { opacity:.6; cursor:progress; }
  a { display:block; text-align:center; margin-top:12px; color:inherit; opacity:.7; font-size:.9rem; }
  p.note { font-size:.85rem; opacity:.75; }
  p.err { color:#8a2f21; font-size:.9rem; }
</style></head>
<body>
  <main class="card">
    <span class="tag">Simulated · no documents, no vendor</span>
    <h1>Verify your identity</h1>
    <p class="note">This page stands in for Sumsub's hosted check. Set <code>KYC_PROVIDER=sumsub</code> with API keys to use the real one.</p>
    <label for="name">Full name, as on your ID</label>
    <input id="name" autocomplete="name" placeholder="Jan Kowalski">
    <p class="note">Your name stays in this page: it is <b>never</b> sent to the backend and never goes on chain. The
      chain gets a level and a salted hash of the vendor's applicant id — nothing else.</p>
    <dl>
      <dt>Wallet</dt><dd><code>${esc(session.wallet)}</code></dd>
      <dt>Session</dt><dd><code>${esc(session.id)}</code></dd>
    </dl>
    <button id="approve">Approve (simulated)</button>
    <button id="decline" class="ghost">Simulate a rejection</button>
    <p class="err" id="err" hidden></p>
    <a href="${esc(back)}cancelled&session=${esc(session.id)}">Cancel and go back</a>
  </main>
  <script type="module">
    const err = document.getElementById("err");
    const send = async (decision, button) => {
      button.disabled = true; err.hidden = true;
      try {
        // Only the session id and the decision are in this request. Who it is for, and what level
        // it writes, are the backend's: the page cannot name a wallet.
        const res = await fetch("/api/webhooks/kyc", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: ${jsonForScript(session.id)}, decision }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "the webhook rejected this decision (" + res.status + ")");
        location.href = ${jsonForScript(`${back}done&session=${session.id}`)};
      } catch (e) {
        err.textContent = e.message; err.hidden = false; button.disabled = false;
      }
    };
    document.getElementById("approve").addEventListener("click", (e) => send("approve", e.currentTarget));
    document.getElementById("decline").addEventListener("click", (e) => send("decline", e.currentTarget));
  </script>
</body></html>`;
}
