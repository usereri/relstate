# Contract 6: Treasury (custodial for the demo, stated as such)

| Question | Answer |
|---|---|
| Who holds on-ramped USDC? | Treasury reserve: a backend-owned devnet-USDC token account |
| Who wraps to rUSDC? | Backend, using the treasury mint authority, only after a confirmed MoneyGram cash-in (demo: Stripe test-mode webhook, see `stripe.md`) |
| What triggers wrap? | `onramp.completed` event (Contract 4) -> `treasury.wrap(wallet, amount)` |
| Deposit funding | Backend mints rUSDC to tenant and sponsors `deposit` + `apply pending` for **everything except the lease deposit** — see "Keep the deposit public" below |
| Payout | Landlord withdraws confidential -> public rUSDC (sponsored) -> `treasury.unwrap(wallet, amount)` burns it and releases USDC to a mocked payout screen (no real money moves) |
| Invariant | `rUSDC supply <= reserve USDC balance`, checked after every wrap/unwrap |
| Keys | treasury mint authority + freeze authority, auditor ElGamal secret, fee payer, attestation issuer: four separate keys, all in backend secrets, never in the app |

Honest framing: the peg is a custodial promise backed by a reserve we control; devnet USDC is test-only. A trust-minimised on-chain wrapper is post-demo.

## Keep the deposit public

Only **rent** is confidential. The deposit vault is a PDA-owned token account and a PDA cannot hold ElGamal keys, so `fund_deposit` moves a **public** amount with `transfer_checked` (`docs/privacy.md`, `program-interface.md` §5). A tenant whose whole balance went confidential cannot accept a lease: the transfer into the vault fails with insufficient funds, several steps away from the cause.

So the wrap flow holds the deposit back rather than withdrawing it afterwards, which would cost an extra proof plan:

```ts
await treasury.wrapAndMakeConfidential({
  owner,                            // the tenant's signer
  amount: onRampedAmount,
  publicHoldback: lease.depositAmount,   // stays public for fund_deposit
  keys,                             // tenant's ElGamal/AES, from the solana-conf-bal/v1 signature
});
```

`confidentialMoveAmount(total, publicHoldback)` is exported separately and throws if the holdback exceeds the wrapped amount, so the mistake surfaces at the treasury rather than on chain.

## Implementation notes (`backend/src/treasury.ts`)

| | |
|---|---|
| `wrap({ wallet, amount })` | asserts `supply + amount <= reserve`, creates the tenant's rUSDC account if needed (treasury pays rent), mints. Balance lands **public** |
| `wrapAndMakeConfidential({ owner, amount, publicHoldback, keys })` | the above, then `deposit` + `apply pending` for `amount - publicHoldback` |
| `unwrap({ owner, amount })` | burns from the public balance, then releases the reserve. **Burn first, release second**, so the invariant never breaks in between |
| `invariant()` / `assertInvariant(additional)` | `{ supply, reserve, ok, headroom, reserveSource }`; the assert throws `InvariantViolation` (HTTP 409) |
| `creditReserve` / `releaseReserve` | the USDC leg. In live mode the reserve moves because real USDC moved, so these only log; the real off-ramp payout is workstream E |
| `sponsorConfidentialAccountSetup({ txBase64 })` | co-signs a wallet-built first-use setup, treasury pays fee **and rent** |

`unwrap` needs the owner's signature: the treasury is the mint and freeze authority but not the token owner, and Token-2022 `Burn` is authorised by the owner. That is deliberate — a custodial backend cannot unilaterally destroy a user's balance. A confidential balance must be withdrawn to the public balance first.

### Mock mode

`BACKEND_MODE=mock` skips the real USDC leg and keeps the reserve as an in-memory counter, but still mints and burns rUSDC for real and still enforces the invariant against that counter. A wrap in mock mode therefore **still fails** if the reserve was never credited — the check is not short-circuited because the money is imaginary. `POST /api/treasury/credit-reserve` (admin) stands in for the on-ramp webhook.

### Why the setup path uses the treasury key, not the fee payer

`POST /api/sponsor` refuses any transaction that references the fee payer inside an instruction, because the fee payer is always a writable signer and a referencing instruction could drain it. Creating a confidential account cannot satisfy that rule — someone has to fund the account's rent.

So that one flow uses the **treasury** key through `POST /api/treasury/confidential-account`, with its own bounds:

- a four-program allowlist (associated-token, Token-2022, ZK ElGamal proof, ComputeBudget) and **no System program**, so no direct SOL transfer is expressible;
- every other required signature present and cryptographically verified against the message bytes;
- the transaction is simulated with the treasury account requested, and the resulting lamport delta must be at or under `SPONSOR_MAX_RENT_LAMPORTS`. Simulation does not charge fees, so that delta is exactly what the instructions themselves would take.

The fee-payer rule in `/api/sponsor` therefore stays absolute, with no exception carved into it.

## Binding rent-payment transactions to the session wallet

`POST /api/treasury/rent-payment` (`sponsorRentPayment`) co-signs the 5 transactions of a confidential rent payment with the treasury key. The measured plan (devnet, 2026-10-11):

| tx | contents | signers besides the treasury |
|----|----------|------------------------------|
| 1 | createAccount(ctx A) + verify into A | ctx A keypair |
| 2 | createAccount(ctx B) + verify into B | ctx B keypair |
| 3 | createAccount(ctx C, range-proof context) | ctx C keypair |
| 4 | verify range proof into C | none |
| 5 | confidential transfer + `pay_rent` + 3 closes | **the tenant** |

Only tx 5 is signed by the tenant, so "the session wallet signs every transaction" cannot hold. The binding is a per-wallet **plan registry** (`backend/src/rentplan.ts`) on top of the shape filter (`rentshape.ts`), which is unchanged:

- Session auth identifies the wallet. A transaction the wallet signs is the final one (the shape filter already forces the wallet to be the transfer's authority and `pay_rent`'s tenant).
- A transaction the wallet does **not** sign is a *preparation* transaction and is accepted only if: the wallet already has an rUSDC token account (setup that costs real work, so wallets are not free to rotate); it creates or verifies a proof context (a tx with no context is refused, `no-wallet-relation`); every context it verifies or closes is created in that same transaction or is already registered to **this** wallet by an earlier accepted transaction (`foreign-context`); it does not re-create a context that is registered to anyone (`context-reused`).
- Created contexts are registered to the wallet. Closes in the final transaction consume them, so a context is spent once; replaying a preparation transaction after completion references an unregistered context and is refused.
- A wallet has one live plan: at most 6 preparation transactions (`plan-full`; any transaction that creates a context counts, whoever signs it, and the rUSDC-account requirement applies to those too) and a 5 minute lifetime, after which its contexts are forgotten. At most 2000 plans are live at once (`registry-full`).
- The registry has one store (wallet -> plan); ownership is derived from it. Rollback undoes only the delta of the failed request (idempotent), never a snapshot, so concurrent requests cannot disturb each other.
- A send that errors without proving the transaction did not land (anything but blockhash not found/expired) is an unknown outcome (`send-outcome-unknown`): the spend stays booked, the replay entry and the plan are kept, and the TTL cleans up. Only definite failures (simulation, blockhash) undo.
- `/api/sponsor` and every `/api/treasury/*` route carry a per-IP limiter (`TREASURY_RATE_PER_MINUTE`, default 60), so failing requests are not free.
- Registry changes are applied after the shape, signature, limiter and replay checks, and undone if the simulation or send fails, so a retry is legitimate.
- Unchanged: shape filter (treasury only as createAccount funder, proof-context authority, close destination), size and lamport caps per account, simulated spend cap, replay guard, per-wallet and global limiters.

Residual (stated in `rentshape.ts`): tx 3 creates a funded, unverified range context. A client can have the treasury fund one and then claim it by verifying with a different authority in their own transaction. The wallet binding does not close this; it bounds it. Measured ceiling with the real limiter: **25,908,000 lamports (0.0259 SOL) per wallet per day** (12 transactions) and **97,155,000 (0.097 SOL) per day for the whole backend** (45). The 6-per-plan cap bounds one plan, not a day, because a completed plan is deleted. The treasury cannot recover a claimed context. The rUSDC-account requirement filters empty wallets, not determined ones (the account is nearly free on devnet); the real fix is a treasury-owned pool of pre-created contexts.

### Restart orphans

The registry is in memory, so a restart (or the 5 minute TTL) between tx 1 and tx 5 forgets the contexts: tx 5's closes are then refused (`foreign-context`) and up to about 6.2M lamports (1,468,120 + 2,606,040 + 2,159,000) stay in context accounts. Contexts that were verified have the treasury as authority and can be closed with the treasury key: `node scripts/reclaim-contexts.ts` lists them (dry run), `--execute` closes accounts older than 10 minutes with the rent returned to the treasury, and `--accounts A,B` names candidates on RPC tiers without `getProgramAccounts`. Never run automatically. A context created but never verified has no authority yet and cannot be closed by anyone.

## Auditing a rent payment

`pay_rent` credits `lease.rent_amount` whatever was actually sent, because it cannot see a hidden amount (`docs/privacy.md`). `verifyRentPayment(rpc, signature, { relstateProgram, expectedAmount, auditorSecret })` is the after-the-fact check the auditor key exists for: it pairs the confidential `Transfer` directly before the `pay_rent` instruction — the program's own layout rule — decrypts the auditor ciphertext, and compares. `auditTransaction` returns every transfer in a transaction with its decrypted amount.
