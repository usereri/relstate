// Phase 1 gate: wrap -> confidential transfer between two accounts -> auditor
// decrypts the amount -> unwrap, with the reserve invariant asserted at every step.
//
// Runs against the real devnet rUSDC mint. `mode: "mock"` keeps the reserve as an
// in-memory ledger (the USDC leg is skipped) while rUSDC is still minted and burnt
// for real. The two wallets hold no SOL: the treasury pays every fee and all rent.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchMint, fetchToken } from "@solana-program/token-2022";
import type { ElGamalSecretKey } from "@solana/zk-sdk";
import { generateKeyPairSigner, type Address, type Signature } from "@solana/kit";
import {
  applyPendingBalance,
  associatedTokenAddress,
  auditTransaction,
  confidentialTransfer,
  confidentialWithdraw,
  type AuditedTransfer,
} from "../src/confidential.ts";
import { env } from "../src/env.ts";
import { confidentialKeysFromIkm, getAuditorKeys, getKey } from "../src/keys.ts";
import { createPlanRunner, getSolanaClient } from "../src/rpc.ts";
import { InvariantViolation, createTreasury, type TreasuryRpc } from "../src/treasury.ts";

const AMOUNT = 1_000_000n; // 1 rUSDC wrapped
const HOLDBACK = 400_000n; // stays public: what fund_deposit will need
const SEND = 250_000n; // confidential tenant -> landlord (> 16 bits, so both halves of the ciphertext matter)

const missing = [env.rusdcMint === "" && "RUSDC_MINT", env.treasuryKeypair === "" && "TREASURY_KEYPAIR", env.rusdcAuditorIkm === "" && "RUSDC_AUDITOR_IKM"].filter(
  (x): x is string => x !== false,
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("treasury on devnet", () => {
  it("wrap -> confidential transfer -> auditor decrypts -> unwrap, invariant holding throughout", async (t) => {
    if (missing.length > 0) {
      const reason = `skipped: ${missing.join(", ")} not set`;
      console.log(reason);
      t.skip(reason);
      return;
    }

    const lines: string[] = [];
    const step = (message: string) => {
      lines.push(message);
      console.log(`  • ${message}`);
    };

    const client = getSolanaClient();
    const rpc = client.rpc as TreasuryRpc;
    const mint = env.rusdcMint as Address;
    const treasuryKey = await getKey("treasury");
    const treasury = createTreasury({
      rpc,
      run: createPlanRunner(client, (...args) => console.log("   ", ...args)),
      treasury: treasuryKey.signer,
      mint,
      decimals: env.rusdcDecimals,
      mode: "mock",
    });

    const tenant = await generateKeyPairSigner();
    const landlord = await generateKeyPairSigner();
    const tenantKeys = confidentialKeysFromIkm(new Uint8Array(32).fill(11));
    const landlordKeys = confidentialKeysFromIkm(new Uint8Array(32).fill(22));
    const auditor = getAuditorKeys();
    const tenantToken = await associatedTokenAddress(tenant.address, mint);
    const landlordToken = await associatedTokenAddress(landlord.address, mint);

    const publicBalance = async (token: Address) => (await fetchToken(rpc, token)).data.amount;
    const assertInvariant = async (label: string) => {
      const report = await treasury.invariant();
      assert.ok(report.ok, `${label}: invariant broken (supply ${report.supply}, reserve ${report.reserve})`);
      return report;
    };

    // The mint is shared across runs. In mock mode the reserve ledger is seeded from the
    // mint's existing supply, so a fresh process starts at exactly zero headroom.
    const baseline = (await fetchMint(rpc, mint)).data.supply;
    const start = await assertInvariant("start");
    assert.equal(start.supply, baseline);
    assert.equal(start.reserve, baseline);
    assert.equal(start.headroom, 0n);

    // 1. A wrap with nothing backing it must fail and must not mint.
    await assert.rejects(treasury.wrap({ wallet: tenant.address, amount: 1n }), InvariantViolation);
    assert.equal((await treasury.invariant()).supply, baseline, "a refused wrap minted nothing");

    // 2. Credit the reserve, then a wrap larger than it must still fail.
    treasury.creditReserve(AMOUNT, "devnet test deposit");
    assert.equal((await assertInvariant("after credit")).reserve, baseline + AMOUNT);
    await assert.rejects(treasury.wrap({ wallet: tenant.address, amount: AMOUNT + 1n }), InvariantViolation);
    assert.equal((await treasury.invariant()).supply, baseline);

    // 3. Wrap and make confidential, keeping a public holdback for fund_deposit.
    const wrapped = await treasury.wrapAndMakeConfidential({ owner: tenant, amount: AMOUNT, publicHoldback: HOLDBACK, keys: tenantKeys });
    step(`wrapped ${AMOUNT}; ${wrapped.confidentialAmount} confidential, ${wrapped.publicRemaining} public`);
    assert.equal(wrapped.token, tenantToken);
    assert.equal(wrapped.confidentialAmount, AMOUNT - HOLDBACK);
    assert.equal(await publicBalance(tenantToken), HOLDBACK, "public balance left equals the holdback");
    const afterWrap = await assertInvariant("after wrap");
    assert.equal(afterWrap.supply, baseline + AMOUNT);
    assert.equal(afterWrap.reserve, baseline + AMOUNT);

    // 4. The landlord's confidential account, then the confidential transfer.
    await treasury.ensureAccount(landlord, landlordKeys);
    const mintAccount = (await fetchMint(rpc, mint)).data;
    const signatures = await confidentialTransfer({
      run: createPlanRunner(client, (...args) => console.log("   ", ...args)),
      rpc,
      payer: treasuryKey.signer,
      authority: tenant,
      sourceToken: tenantToken,
      destinationToken: landlordToken,
      mint,
      mintAccount,
      amount: SEND,
      sourceKeys: tenantKeys,
    });
    step(`confidential transfer of ${SEND} took ${signatures.length} transactions`);
    assert.ok(signatures.length > 0);
    // A confidential transfer moves value between the confidential halves only.
    assert.equal(await publicBalance(tenantToken), HOLDBACK);
    assert.equal(await publicBalance(landlordToken), 0n);
    await assertInvariant("after transfer");

    // 5. The auditor decrypts the amount from the chain. Which signature carries the
    //    ConfidentialTransfer instruction is found by searching, not assumed.
    const transfers = await findTransfers(client.rpc, signatures, auditor.elgamal.secret());
    assert.equal(transfers.length, 1, "exactly one transfer instruction in the plan");
    const [audited] = transfers as [AuditedTransfer];
    assert.equal(audited.amount, SEND, "the auditor decrypts the amount that was sent");
    assert.equal(audited.sourceToken, tenantToken);
    assert.equal(audited.destinationToken, landlordToken);
    assert.equal(audited.mint, mint);
    step(`auditor decrypted ${audited.amount} from ${audited.signature}`);

    // The tenant's remaining 350k confidential balance (and 400k public) is left behind on purpose:
    // recovering it costs another proof plan on a throwaway key, for nothing on a devnet demo mint.
    // Do not "fix" this; the next run's baseline accounts for it.

    // 6. Landlord applies the pending balance, withdraws to public, and unwraps.
    const common = { run: createPlanRunner(client), rpc, payer: treasuryKey.signer };
    await applyPendingBalance({ ...common, owner: landlord, token: landlordToken, keys: landlordKeys });
    await confidentialWithdraw({
      ...common,
      owner: landlord,
      token: landlordToken,
      mint,
      amount: SEND,
      decimals: env.rusdcDecimals,
      keys: landlordKeys,
    });
    assert.equal(await publicBalance(landlordToken), SEND, "withdrawn amount is public again");
    await assertInvariant("after withdraw");

    const unwrapped = await treasury.unwrap({ owner: landlord, amount: SEND });
    assert.ok(unwrapped.signatures.length > 0);
    assert.equal(await publicBalance(landlordToken), 0n);
    const end = await assertInvariant("after unwrap");
    assert.equal(end.supply, baseline + AMOUNT - SEND);
    assert.equal(end.reserve, baseline + AMOUNT - SEND);
    step(`unwrapped ${SEND}; supply ${end.supply}, reserve ${end.reserve}`);

    const kinds = treasury.ledger().map((e) => e.kind);
    assert.ok(kinds.includes("wrap") && kinds.includes("unwrap") && kinds.includes("credit") && kinds.includes("debit"));
  });
});

/** Audits each signature until the plan's transfer is found; getTransaction can lag confirmation slightly. */
async function findTransfers(
  rpc: ReturnType<typeof getSolanaClient>["rpc"],
  signatures: Signature[],
  auditorSecret: ElGamalSecretKey,
): Promise<AuditedTransfer[]> {
  const found: AuditedTransfer[] = [];
  for (const signature of signatures) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        found.push(...(await auditTransaction(rpc, signature, auditorSecret)));
        break;
      } catch (error) {
        if (!/not found/.test(String(error)) || attempt === 4) throw error;
        await sleep(1500);
      }
    }
  }
  return found;
}
