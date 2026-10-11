/**
 * The two private-money flows, with no React in them.
 *
 *   1. {@link securePrivateBalance} — finishing a top-up. The Stripe webhook can only mint rUSDC
 *      to the tenant's PUBLIC balance: `Deposit` and `ApplyPendingBalance` are owner-signed and the
 *      latter re-encrypts the balance locally, and nobody but the wallet holds that key
 *      (docs/contracts/stripe.md, "Where the confidential move happens"). So the browser finishes
 *      the job, over sponsored transactions, the first time it is in a position to.
 *
 *   2. {@link payRentPrivately} — paying rent. One flow, several transactions: the proofs are
 *      staged in context-state accounts and the Token-2022 transfer lands in the last transaction
 *      with `pay_rent` spliced in DIRECTLY after it, which is the only position the program accepts
 *      (docs/contracts/program-interface.md §3).
 *
 * Both are driven by a progress callback rather than returning only at the end: a proof plan is
 * four or five transactions against a rate-limited endpoint, so a UI with nothing to say for forty
 * seconds looks broken. Every message here is written for a tenant, not for us: no "ElGamal", no
 * "ciphertext", no "ATA".
 */
import type { LeaseView, Me } from "./chain";
import * as chain from "./chain";
import type { ConfidentialSession } from "./confidential";
import { mintKind } from "./mint";
import type { WalletProvider } from "./wallet";

/** Where a flow has got to. The UI maps these to one line of plain English each. */
export type Phase =
  | "unlocking"
  | "account"
  | "securing"
  | "proving"
  | "paying"
  | "confirming"
  | "done";

export interface Progress {
  phase: Phase;
  /** Already written for a person to read. */
  message: string;
  /** Set while a multi-transaction plan is being submitted. */
  step?: number;
  steps?: number;
}

export type OnProgress = (p: Progress) => void;

const report = (onProgress: OnProgress | undefined, phase: Phase, message: string, step?: number, steps?: number) =>
  onProgress?.({ phase, message, ...(step === undefined ? {} : { step }), ...(steps === undefined ? {} : { steps }) });

/** The one phrase the UI shows while the private-balance step runs. No crypto words, by design. */
export const SECURING_MESSAGE = "Securing your balance…";

export interface SecureResult {
  /** Base units moved from the public balance into the private one. Zero when there was nothing to move. */
  secured: bigint;
  /** Base units deliberately left public, so `fund_deposit` can still spend them. */
  heldBack: bigint;
  /** True when the wallet's private-balance account had to be created first. */
  createdAccount: boolean;
  signatures: string[];
}

/**
 * Moves everything except `holdback` from the wallet's public rUSDC balance into its private one.
 *
 * `holdback` is not an optimisation: the deposit vault is a program account and a program account
 * cannot hold decryption keys, so `fund_deposit` moves a **public** amount. A tenant whose whole
 * balance went private cannot accept a lease, and the failure surfaces as "insufficient funds"
 * several steps from the cause (docs/contracts/treasury.md, "Keep the deposit public").
 *
 * Idempotent in effect: with nothing public to move it reports `secured: 0n` and sends nothing, so
 * the caller can run it on every visit without checking first.
 */
export function securePrivateBalance(opts: {
  wallet: WalletProvider;
  /** Defaults to the configured rUSDC mint, or the one the backend reports. */
  mint?: string;
  holdback?: bigint;
  onProgress?: OnProgress;
}): Promise<SecureResult> {
  // One run per wallet at a time. React re-mounts an effect in development, and a second tab or a
  // Retry can overlap a slow run too; two concurrent runs both see "no account yet" and the loser's
  // transactions fail on chain (a second ConfigureAccount, a double deposit).
  const key = opts.wallet.publicKey?.toBase58() ?? "";
  const running = key ? secureInFlight.get(key) : undefined;
  if (running) return running;
  const run = secureOnce(opts).finally(() => secureInFlight.delete(key));
  if (key) secureInFlight.set(key, run);
  return run;
}

const secureInFlight = new Map<string, Promise<SecureResult>>();

async function secureOnce(opts: {
  wallet: WalletProvider;
  mint?: string;
  holdback?: bigint;
  onProgress?: OnProgress;
}): Promise<SecureResult> {
  const conf = await chain.confidential();
  const holdback = opts.holdback ?? 0n;
  report(opts.onProgress, "unlocking", SECURING_MESSAGE);
  const session = await conf.openSession({ wallet: opts.wallet, mint: opts.mint });
  const result = await secureWithin(session, holdback, opts.onProgress);
  report(opts.onProgress, "done", "Your balance is private.");
  return result;
}

/**
 * Creates and configures the wallet's private-balance account if it has none, and nothing else.
 *
 * Split out because the receiving side needs exactly this and no more. A landlord's **public**
 * rUSDC balance is what the payout screen burns on unwrap, so sweeping it into the private side
 * would quietly break their cash-out; they only need an account that can be paid into. Only the
 * owner's own signature can configure it, which is why a tenant cannot do it for them.
 */
export async function enablePrivateReceiving(opts: {
  wallet: WalletProvider;
  mint?: string;
  onProgress?: OnProgress;
}): Promise<{ created: boolean; signatures: string[] }> {
  const conf = await chain.confidential();
  report(opts.onProgress, "unlocking", "Setting up your private balance…");
  const session = await conf.openSession({ wallet: opts.wallet, mint: opts.mint });
  const result = await ensureAccountWithin(session, opts.onProgress);
  report(opts.onProgress, "done", "Ready to receive private payments.");
  return result;
}

async function ensureAccountWithin(
  session: ConfidentialSession,
  onProgress?: OnProgress,
): Promise<{ created: boolean; signatures: string[] }> {
  const conf = await chain.confidential();
  if ((await conf.accountState(session)).configured) return { created: false, signatures: [] };
  report(onProgress, "account", SECURING_MESSAGE);
  // The treasury co-signs and funds this one, not the fee-payer sponsor, so it goes through the
  // other route (docs/contracts/treasury.md, "Why the setup path uses the treasury key").
  const setup = { ...session, submit: session.submitSetup };
  return { created: true, signatures: await conf.runPlan(setup, await conf.planCreateAccount(session)) };
}

/** The body of {@link securePrivateBalance}, reused by the rent flow so one session covers both. */
async function secureWithin(session: ConfidentialSession, holdback: bigint, onProgress?: OnProgress): Promise<SecureResult> {
  const conf = await chain.confidential();
  const account = await ensureAccountWithin(session, onProgress);
  const signatures = [...account.signatures];
  const createdAccount = account.created;

  const state = await conf.accountState(session);
  const moveable = state.publicAmount > holdback ? state.publicAmount - holdback : 0n;
  if (moveable === 0n) return { secured: 0n, heldBack: holdback, createdAccount, signatures };

  report(onProgress, "securing", SECURING_MESSAGE);
  const decimals = await conf.mintDecimals(session);
  signatures.push(...(await conf.runPlan(session, await conf.planDeposit(session, { amount: moveable, decimals }))));
  // Built only now, and never in the same transaction as the deposit: applying re-encrypts the new
  // balance from the account's CURRENT state, so a plan made before the deposit landed would carry
  // the wrong figure and be rejected on chain.
  signatures.push(...(await conf.runPlan(session, await conf.planApplyPending(session))));
  return { secured: moveable, heldBack: holdback, createdAccount, signatures };
}

export interface PayResult {
  /** What was sent, in base units. Known to us because we built the transfer; never readable on chain. */
  amount: number;
  /** The transaction carrying the transfer and `pay_rent` — the one worth linking to in a receipt. */
  signature: string;
  /** Every transaction in the plan, in order, proofs included. */
  signatures: string[];
  /** Set when the balance had to be moved into the private side before the payment could be made. */
  secured?: SecureResult;
}

export class PayError extends Error {
  /** True when the user can fix it themselves (top up, ask the landlord) rather than retry. */
  readonly actionable: boolean;
  constructor(message: string, actionable = true) {
    super(message);
    this.name = "PayError";
    this.actionable = actionable;
  }
}

/**
 * Pays one rent period with a confidential transfer, with `pay_rent` in the same transaction.
 *
 * The amount is encrypted to the tenant, the landlord and the mint's auditor key; the program sees
 * that a transfer of the right shape happened and records the period, not the figure. That gap is
 * closed after the fact by `POST /api/rent/verify`, which decrypts with the auditor key and
 * compares against the lease (docs/privacy.md).
 */
export async function payRentPrivately(opts: { me: Me; lease: LeaseView; onProgress?: OnProgress }): Promise<PayResult> {
  const { me, lease, onProgress } = opts;
  const conf = await chain.confidential();
  const rent = BigInt(lease.rent);

  const kind = await mintKind(lease.mint);
  if (!kind.confidential) {
    throw new PayError("This lease is not settled in a private token, so rent is paid the ordinary way.", false);
  }

  report(onProgress, "unlocking", "Unlocking your private balance…");
  const session = await conf.openSession({ wallet: me.wallet, mint: lease.mint });

  // Cover the rent from the private balance, moving public funds across if that is what is needed.
  // Nothing is held back: an active lease has its deposit in the vault already.
  let secured: SecureResult | undefined;
  let balance = await conf.loadBalance(session).catch(() => null);
  if (!balance || balance.availableBalance < rent) {
    secured = await secureWithin(session, 0n, onProgress);
    balance = await conf.loadBalance(session).catch(() => null);
  }
  if (!balance) {
    throw new PayError("Your private balance could not be read. Check your connection and try again.", false);
  }
  if (balance.availableBalance < rent) {
    throw new PayError(
      `Your balance is ${format(balance.availableBalance + balance.pendingBalance, kind.decimals)}, and this rent is ` +
        `${format(rent, kind.decimals)}. Add funds first.`,
    );
  }

  // The landlord's side has to exist before anything can be sent to it, and only the landlord's own
  // signature can create it — so this is their problem to fix, and the message says so.
  const destination = await conf.confidentialTokenAccount(lease.landlord, lease.mint);
  const landlord = await conf.accountState(session, destination);
  if (!landlord.configured) {
    throw new PayError("Your landlord cannot receive private payments yet: their account has not been set up. Ask them to open their Relstate wallet once.");
  }

  report(onProgress, "proving", "Preparing a private payment…");
  const payRent = await conf.fromWeb3Instruction(await chain.payRentInstruction(me, lease));
  // The proof plan funds its context-state accounts from the payer, so the payer appears inside
  // instructions and `/api/sponsor` would refuse every transaction of it. The treasury pays for this
  // plan instead (`/api/treasury/rent-payment`), and gets the rent back when the plan closes them.
  const rentSession: ConfidentialSession = { ...session, payer: session.setupPayer, submit: session.submitRentPayment };
  const messages = await conf.planTransfer(rentSession, { destinationToken: destination, amount: rent, rightAfterTransfer: [payRent] });
  const carriesPayment = conf.transferMessageIndex(messages);

  report(onProgress, "paying", "Sending your rent…", 0, messages.length);
  const signatures = await conf.runPlan(rentSession, messages, (done, steps) =>
    report(onProgress, done === steps ? "confirming" : "paying", done === steps ? "Confirming…" : "Sending your rent…", done, steps),
  );

  report(onProgress, "done", "Rent paid.");
  return { amount: lease.rent, signature: signatures[carriesPayment]!, signatures, secured };
}

export interface RevealedBalance {
  /** Received and not yet folded into the spendable balance. One rent payment arrives here. */
  incoming: bigint;
  spendable: bigint;
  total: bigint;
  decimals: number;
}

/**
 * The landlord's own view of what they were paid.
 *
 * This is the only way an amount can be shown on the receiving side: nothing public carries it.
 * The figure is decrypted in the browser with the landlord's own viewing key, derived from their
 * own wallet signature — so it is theirs to see and nobody reads it off the chain
 * (docs/privacy.md, "Keys"). `pay_rent` publishes that a period was paid, never how much.
 */
export async function revealReceived(opts: { wallet: WalletProvider; mint?: string; onProgress?: OnProgress }): Promise<RevealedBalance> {
  const conf = await chain.confidential();
  report(opts.onProgress, "unlocking", "Unlocking your view of the payment…");
  const session = await conf.openSession({ wallet: opts.wallet, mint: opts.mint });
  const [balance, decimals] = await Promise.all([conf.loadBalance(session), conf.mintDecimals(session)]);
  if (!balance) {
    throw new PayError("You have no private balance on this network yet, so there is nothing to show.", false);
  }
  report(opts.onProgress, "done", "Decrypted.");
  return {
    incoming: balance.pendingBalance,
    spendable: balance.availableBalance,
    total: balance.totalBalance,
    decimals,
  };
}

/** Base units to a human figure. Kept here so the lib and the screen cannot disagree. */
export function format(base: bigint | number, decimals = 6): string {
  const n = BigInt(base);
  const unit = 10n ** BigInt(decimals);
  const whole = n / unit;
  const cents = ((n % unit) * 100n) / unit;
  return `${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

/**
 * Turns whatever went wrong into one sentence a tenant can act on.
 *
 * The failures worth distinguishing all look alike in a stack trace but mean entirely different
 * things to the person: a rate-limited RPC is "wait", a sponsor cap is "wait", an expired blockhash
 * is "try again", a missing key-derivation capability is "this wallet cannot do this at all".
 */
export function payErrorMessage(e: unknown): string {
  if (e instanceof PayError) return e.message;
  const message = e instanceof Error ? e.message : String(e ?? "");
  if (/429|rate.?limit/i.test(message)) {
    return "The network is rate-limiting us right now. The app keeps retrying on its own — give it a few seconds, then try again.";
  }
  if (/expired/i.test(message)) return "That took too long and the transaction went stale. Nothing was paid; try again.";
  if (/insufficient/i.test(message)) return "There is not enough in your balance to cover this payment.";
  if (/MissingConfidentialTransfer/i.test(message)) {
    return "The payment was assembled in the wrong order and the program refused it. Nothing was paid. This is a bug in the app: please report it.";
  }
  if (/no confidential mint configured/i.test(message)) {
    return "This app has no private-payment token configured yet, so rent cannot be paid privately here.";
  }
  if (/cannot derive confidential-balance keys/i.test(message)) {
    return "This wallet cannot hold a private balance, because it cannot sign the one message the keys are derived from. Sign in with your email wallet instead.";
  }
  if (/No backend configured|nobody to pay the fee/i.test(message)) {
    return "The app is not connected to a backend, so there is nobody to pay the network fee for you.";
  }
  if (/fetch|network|load failed/i.test(message)) return "Could not reach the backend. Check your connection and try again.";
  // Anything else: the program's own error text is usually the most useful thing available.
  return chain.errorMessage(e);
}
