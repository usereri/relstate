// Real wire transactions shaped like the confidential rent payment plan (measured on devnet), for
// the rentshape and rent-payment-route tests. Everything is built with kit, nothing is mocked.
import {
  AccountRole,
  generateKeyPairSigner,
  getAddressEncoder,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { COMPUTE_BUDGET_PROGRAM, RELSTATE_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, ZK_ELGAMAL_PROOF_PROGRAM } from "../src/contracts.ts";
import { PAY_RENT_DISCRIMINATOR, type RentPaymentRules } from "../src/rentshape.ts";
import { buildTx } from "./txfixtures.ts";

export const ZK = ZK_ELGAMAL_PROOF_PROGRAM as Address;
export const TOKEN22 = TOKEN_2022_PROGRAM as Address;
export const SYSTEM = SYSTEM_PROGRAM as Address;
export const RELSTATE = RELSTATE_PROGRAM as Address;
export const BUDGET = COMPUTE_BUDGET_PROGRAM as Address;

export type Who = Address | KeyPairSigner;
export const addressOf = (who: Who): Address => (typeof who === "string" ? who : who.address);

/** An instruction account; a signer object is attached when the role is a signing one. */
export const acct = (who: Who, role: AccountRole) => ({
  address: addressOf(who),
  role,
  ...(typeof who !== "string" && (role === AccountRole.WRITABLE_SIGNER || role === AccountRole.READONLY_SIGNER) ? { signer: who } : {}),
});
export const W = AccountRole.WRITABLE;
export const R = AccountRole.READONLY;
export const WS = AccountRole.WRITABLE_SIGNER;
export const RS = AccountRole.READONLY_SIGNER;

export const ix = (programAddress: Address, data: number[] | Uint8Array, accounts: Array<ReturnType<typeof acct>> = []): Instruction =>
  ({ programAddress, data: new Uint8Array(data), accounts }) as unknown as Instruction;

export const u64 = (n: bigint) => [...new Uint8Array(new BigUint64Array([n]).buffer)];

/**
 * The three context states a real rent payment creates, as measured on devnet by
 * `GATE_DUMP=1 node scripts/exit-gate.ts --probe` (2026-10-10). Pinning the filter to these is the
 * point: tests that invent sizes prove nothing about the plan we actually have to co-sign.
 */
export const REAL_CONTEXTS = {
  equality: { space: 161n, lamports: 1_468_120n, verifyTag: 3 },
  validity: { space: 385n, lamports: 2_606_040n, verifyTag: 12 },
  range: { space: 297n, lamports: 2_159_000n, verifyTag: 7 },
} as const;

export type Cast = Awaited<ReturnType<typeof cast>>;
export async function cast() {
  const [treasury, wallet, other, ctxA, ctxB, ctxC] = await Promise.all(Array.from({ length: 6 }, () => generateKeyPairSigner()));
  const [mint, walletToken, destToken, lease, profile] = (await Promise.all(Array.from({ length: 5 }, () => generateKeyPairSigner()))).map((s) => s.address);
  const rules: RentPaymentRules = {
    treasury: treasury!.address,
    wallet: wallet!.address,
    mint: mint!,
    walletToken: walletToken!,
    maxContextLamports: 3_000_000n,
    maxContextSpace: 400n,
    maxCreateAccounts: 1,
    rangeContextLamports: REAL_CONTEXTS.range.lamports,
  };
  return { treasury: treasury!, wallet: wallet!, other: other!, ctxA: ctxA!, ctxB: ctxB!, ctxC: ctxC!, mint: mint!, walletToken: walletToken!, destToken: destToken!, lease: lease!, profile: profile!, rules };
}

export const createAccountData = (lamports: bigint, space: bigint, owner: Address, length = 52) => {
  const data = new Uint8Array(length);
  if (length < 20) return data;
  const view = new DataView(data.buffer);
  view.setUint32(0, 0, true);
  view.setBigUint64(4, lamports, true);
  view.setBigUint64(12, space, true);
  data.set(getAddressEncoder().encode(owner).subarray(0, Math.max(0, Math.min(32, length - 20))), 20);
  return data;
};

/** The real plan's instructions. Each builder takes the cast so a test can swap one account out. */
export const plan = (c: Cast) => ({
  createContext: (ctx: KeyPairSigner = c.ctxA, overrides: { lamports?: bigint; space?: bigint; owner?: Address } = {}) =>
    ix(SYSTEM, createAccountData(overrides.lamports ?? REAL_CONTEXTS.equality.lamports, overrides.space ?? REAL_CONTEXTS.equality.space, overrides.owner ?? ZK), [acct(c.treasury.address, WS), acct(ctx, WS)]),
  verify: (ctx: Who = c.ctxA, tag = 3) => ix(ZK, [tag, 1, 2, 3], [acct(ctx, W), acct(c.treasury.address, R)]),
  close: (ctx: Who = c.ctxA) => ix(ZK, [0], [acct(ctx, W), acct(c.treasury.address, W), acct(c.treasury.address, RS)]),
  transfer: (accounts?: Array<ReturnType<typeof acct>>, data: number[] = [27, 7, ...new Array(100).fill(1)]) =>
    ix(TOKEN22, data, accounts ?? [acct(c.walletToken, W), acct(c.mint, R), acct(c.destToken, W), acct(c.ctxA.address, R), acct(c.ctxB.address, R), acct(c.ctxC.address, R), acct(c.wallet, RS)]),
  payRent: (accounts?: Array<ReturnType<typeof acct>>, data: Uint8Array = PAY_RENT_DISCRIMINATOR) =>
    ix(RELSTATE, data, accounts ?? [acct(c.wallet, WS), acct(c.lease, W), acct(c.mint, R), acct(c.walletToken, W), acct(c.destToken, W), acct(c.profile, W), acct(TOKEN22, R), acct(SYSTEM, R)]),
  computeLimit: (units = 300_000) => ix(BUDGET, [2, units & 255, (units >> 8) & 255, (units >> 16) & 255, 0]),
  computePrice: (microLamports: bigint) => ix(BUDGET, [3, ...u64(microLamports)]),
});

/** Treasury as fee payer, as the route requires. */
export const build = (c: Cast, instructions: Instruction[]) => buildTx({ feePayer: c.treasury.address, instructions });

/** tx 1 of the real plan. */
export const tx1 = (c: Cast) => { const p = plan(c); return [p.createContext(c.ctxA), p.verify(c.ctxA)]; };
/** tx 5 of the real plan: transfer, pay_rent directly after it, then three closes. */
export const tx5 = (c: Cast) => { const p = plan(c); return [p.transfer(), p.payRent(), p.close(c.ctxA.address), p.close(c.ctxB.address), p.close(c.ctxC.address)]; };
