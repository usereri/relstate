# Contract 6: Treasury (custodial for the demo, stated as such)

| Question | Answer |
|---|---|
| Who holds on-ramped USDC? | Treasury reserve: a backend-owned devnet-USDC token account |
| Who wraps to rUSDC? | Backend, using the treasury mint authority, only after a confirmed on-ramp webhook |
| What triggers wrap? | `onramp.completed` event (Contract 4) -> `treasury.wrap(wallet, amount)` |
| Deposit funding | Backend mints rUSDC to tenant and sponsors `deposit` + `apply pending` for **everything except the lease deposit** — see "Keep the deposit public" below |
| Payout | Landlord withdraws confidential -> public rUSDC (sponsored) -> `treasury.unwrap(wallet, amount)` burns it and releases USDC toward the off-ramp provider (mocked, labelled on stage) |
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

## Auditing a rent payment

`pay_rent` credits `lease.rent_amount` whatever was actually sent, because it cannot see a hidden amount (`docs/privacy.md`). `verifyRentPayment(rpc, signature, { relstateProgram, expectedAmount, auditorSecret })` is the after-the-fact check the auditor key exists for: it pairs the confidential `Transfer` directly before the `pay_rent` instruction — the program's own layout rule — decrypts the auditor ciphertext, and compares. `auditTransaction` returns every transfer in a transaction with its decrypted amount.
