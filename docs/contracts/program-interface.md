# Program interface (Phase 1)

What the `relstate` program expects of its callers after the Phase 1 changes. Lane A (app) and
Lane B (rUSDC mint, backend, scripts) code against this.

Program id: **`G4iMjveQKXztnGoxigAeWPrb5evT9yt6qaLkgQEp2dXm`**

Regenerated, because no keypair for the previously declared `5J52oGfo7Bj…` exists any more, so
the program could not be deployed or tested at all. The app and the scripts read the id from
`target/idl/relstate.json`, so a rebuild picks it up.

The deploy keypair lives **outside the repo**, at `~/.config/relstate/program-keypair.json`, so
every worktree and machine deploys the same id without the private key being in git. `make
test-demo` and `make demo-chain` copy it into `target/deploy/` first (target is generated, and
`cargo clean` wipes it); without the file, anchor silently generates a new id that no longer
matches `declare_id!`. Override with `PROGRAM_KEYPAIR=/path/to/key.json`. See "Program keypair"
in `README.md`.

## 1. Three breaking changes

| Change | Who it affects | What to do |
|---|---|---|
| `tokenProgram` is no longer resolved for you | every caller of `propose_lease`, `fund_deposit`, `pay_rent`, `mark_default`, `release_deposit`, `claim_deposit` | pass it: `TOKEN_PROGRAM_ID` for a classic mint, `TOKEN_2022_PROGRAM_ID` for rUSDC |
| `propose_lease` takes a `config` account | whoever proposes a lease | nothing — it is a PDA with a constant seed, so the Anchor client fills it in |
| A fresh network needs `init_config` + `set_mint_allowed` before any lease | Lane B (`scripts/setup-demo.ts`), devnet deploys | see [§4](#4-setting-up-a-fresh-network) |

The first one is the one that bites. `anchor_spl::token::Token` had a single known address, so the
client could infer it; `Interface<TokenInterface>` accepts both token programs, so it cannot.
Omitting it fails client-side with `Account 'tokenProgram' not provided.`

## 2. Config account

One account per deployment holds the mints a lease may be denominated in. It replaces the
compile-time `ALLOWED_MINT`, which made the mint part of the build and so could never cover an
rUSDC mint created per deployment.

| | |
|---|---|
| Seeds | `[b"config"]` — no further seeds, one account per program |
| Address | `PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0]` |
| Rust type | `Config { admin: Pubkey, bump: u8, mints: Vec<Pubkey> }` |
| Capacity | 8 mints (`MAX_ALLOWED_MINTS`); a 9th returns `MintListFull` |

### Instructions

```ts
// Claims the config for the signer. Succeeds exactly once per network.
program.methods.initConfig()
  .accountsPartial({ admin: admin.publicKey, config })   // + systemProgram
  .signers([admin]).rpc();

// Adds (allowed = true) or removes (false) a mint. Idempotent either way. Admin only.
program.methods.setMintAllowed(allowed /* boolean */)
  .accountsPartial({ admin: admin.publicKey, config, mint /* PublicKey of the mint account */ })
  .signers([admin]).rpc();

// Hands the config to another key. Admin only.
program.methods.setAdmin(newAdmin /* PublicKey */)
  .accountsPartial({ admin: admin.publicKey, config })
  .signers([admin]).rpc();
```

`admin` is the signer in all three. `initConfig` needs it writable (it pays rent); the other two
do not. `setMintAllowed` additionally takes the `mint` account (read-only, no token program),
because it inspects the mint's extensions.

**The allowlist is a security control.** When `allowed = true`, `set_mint_allowed` rejects, at setup
time rather than at first use:

- a `ConfidentialTransferMint` with no auditor ElGamal pubkey (`ConfidentialMintNeedsAuditor`);
- a mint carrying `TransferFeeConfig`, `NonTransferable`, `PermanentDelegate`, `TransferHook`,
  `Pausable`, or `DefaultAccountState` set to frozen (`DisallowedMintExtension`).

Removing a mint (`allowed = false`) never inspects it. `TransferWithFee` (Token-2022 confidential
discriminant 13) is intentionally unmatched by `pay_rent`, since fee mints cannot be allowed.

Errors: `NotAdmin` for the wrong signer, `MintListFull` at capacity, `InvalidNewAdmin` if
`setAdmin` is given the all-zero pubkey. `init_config` on an existing
config fails inside Anchor's `init` (account already in use) — check with
`program.account.config.fetchNullable(config)` first rather than catching it.

**`admin` is whoever calls `init_config` first.** There is one config PDA per deployment and no
way to re-claim it, which is why `set_admin` exists: if the wrong wallet claims it, hand it over
rather than redeploy. For the demo the backend treasury key should end up as admin.

### Effect on `propose_lease`

```
#[account(seeds = [CONFIG_SEED], bump = config.bump)]  config
#[account(constraint = config.allows(&mint.key()))]    mint   -> MintNotAllowed
```

Checked only at propose time, as `ALLOWED_MINT` was. A lease already open on a mint keeps working
after the mint is removed from the list — removal stops new leases, it does not freeze old ones.

## 3. Paying rent

The mint decides how rent moves. `pay_rent` reads the mint's extensions and takes one of two
paths. Nothing on the lease or in the instruction data selects it, so a lease is public or
confidential for its whole life.

| Mint | Path |
|---|---|
| Classic SPL, or Token-2022 **without** `ConfidentialTransferMint` | `pay_rent` moves `lease.rent_amount` itself via `transfer_checked`, exactly as before |
| Token-2022 **with** `ConfidentialTransferMint` (rUSDC) | `pay_rent` moves nothing. The caller puts a confidential `Transfer` in the same transaction and `pay_rent` verifies it by instruction introspection |

### Account list (both paths)

| # | Account | Notes |
|---|---|---|
| 0 | `tenant` | signer |
| 1 | `lease` | PDA `[b"lease", landlord, lease_id_le]`, writable |
| 2 | `mint` | the lease mint |
| 3 | `tenant_ata` | writable, owner = tenant, mint = lease mint |
| 4 | `landlord_ata` | writable, owner = `lease.landlord`, mint = lease mint |
| 5 | `tenant_profile` | PDA `[b"profile", tenant]`, writable |
| 6 | `token_program` | **must be passed** — `TOKEN_2022_PROGRAM_ID` for rUSDC |
| 7 | `instructions` | the instructions sysvar, address-pinned so the Anchor client fills it in |

On the confidential path `tenant_ata` and `landlord_ata` are the *token accounts* — the same
accounts the confidential transfer names, not separate confidential state. Their public balances
are untouched; the money moves inside the extension.

### Required transaction layout, confidential path

```
ix[n-1]  Token-2022 ConfidentialTransferInstruction::Transfer
ix[n]    relstate pay_rent
```

The transfer must be **the instruction directly before `pay_rent`**, and must match on:

| | |
|---|---|
| program id | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (Token-2022) |
| `data[0]` | `27` — `TokenInstruction::ConfidentialTransferExtension` |
| `data[1]` | `7` — `ConfidentialTransferInstruction::Transfer` |
| `accounts[0]` | source token account == `tenant_ata` |
| `accounts[1]` | mint == the lease mint |
| `accounts[2]` | destination token account == `landlord_ata` |

Nothing past `accounts[2]` is inspected, so both proof modes are acceptable *in shape*: inline
proofs (where `accounts[3]` is the instructions sysvar) and proofs pre-verified into context state
accounts. The adjacency rule is what actually constrains the build:

**The standard `spl-token` `transfer()` builder cannot be used as-is.** It hard-requires a
`proof_instruction_offset` of exactly `1, 2, 3` and appends the three proof-verify instructions
*after* the transfer, which lands them between the transfer and `pay_rent` — `MissingConfidentialTransfer`.

- **Pre-verified context state accounts are the easy, supported path**, and the one the app's
  confidential flow uses. The proofs are verified in earlier instructions and the transfer
  references the resulting context state accounts instead of the instructions sysvar, so nothing
  sits between the transfer and `pay_rent` and no offset contortion is needed.
- **Inline proofs** are still reachable, but only by hand-building the transfer instruction with
  *negative* `proof_instruction_offset`s (`-3, -2, -1`) so the three verify instructions precede the
  transfer. `verify_and_extract_context` resolves the offset relatively and accepts negatives. This
  path is correct but is **not** exercised on chain by the local suite (see [§5](#5-known-gaps)).

Both shapes are covered at the matcher level by the Rust unit tests (`accepts_a_matching_transfer`
for the inline/sysvar shape, `accepts_a_transfer_with_pre_verified_proofs` for context state
accounts); neither is driven on chain locally, because that needs real ZK proofs.

Other instructions in the transaction are fine as long as none comes between the transfer and
`pay_rent`. A `ComputeBudget` instruction at the front of the transaction is fine.

`MissingConfidentialTransfer` is the error for anything that does not match: no preceding
instruction, a classic `transfer_checked` instead, a different Token-2022 instruction, the wrong
mint, the wrong source or the wrong destination.

Directly-before rather than anywhere-in-the-transaction is deliberate. The transaction is atomic
either way, so a failing transfer always takes the bookkeeping with it; pinning the position also
pairs exactly one transfer with one recorded payment, so a tenant two periods behind cannot
settle both with a single transfer.

### What is recorded, and what is not

`pay_rent` writes the same counters on both paths: `paid_count`, and `paid_on_time` or
`paid_late` against `lease.grace_secs`. `rent_paid_total` adds **`lease.rent_amount`**, the
contracted rent — on the confidential path the program cannot see what was actually sent, so this
is not a verified settled amount. That is the residual gap `docs/privacy.md` records: the
backend's auditor key checks amount == rent after the fact.

The `RentPaid` event gained a field:

```rust
RentPaid { lease: Pubkey, period: u16, on_time: bool, confidential: bool }
```

### `fund_deposit` account list (KYC change)

`fund_deposit` gained two accounts for the tenant identity gate (`require_kyc`, default off; see
`docs/contracts/attestation.md`): `config` (PDA `[b"config"]`) and `attestation` (PDA
`[b"attestation", tenant]`). Both are derived from accounts the caller already passes, so the Anchor
client fills them in — the same as on `apply`. Hand-built callers must pass them. Failure when the
gate is on and the tenant is unverified: `KycRequired`.

## 4. Setting up a fresh network

Before any lease can be proposed, on localnet or devnet:

1. deploy the program;
2. `init_config()` signed by the key that should own the allowlist (ideally the backend treasury
   key; otherwise hand it over later with `set_admin`);
3. `set_mint_allowed(mint, true)` for every mint leases may use — the classic test-USDC mint, and
   the Token-2022 rUSDC mint once Lane B has created it.

Steps 1-2 must run in the same scripted sequence (`scripts/setup-demo.ts` does this): `init_config`
is first-caller-wins, so a deployed program with no config is claimable by anyone until it runs.
Step 2 is skipped if `program.account.config.fetchNullable(configPda)` already returns an account.
Step 3 is idempotent, so running it again is harmless.

`tests/test-usdc-mint.json` is no longer a prerequisite for `make test-demo` — the suite creates
and allows its own mints. `scripts/setup-demo.ts` still uses the file for the app's mint and still
needs its own `solana-keygen` step.

## 5. Deposit exits and the dispute state machine (D1)

`release_deposit` with a deduction no longer pays anything. It moves the lease to `Disputed` and
records `proposed_deduction` and `disputed_at`. Constants (`constants.rs`, demo / release):
`DISPUTE_WINDOW_SECS` = 30 s / 14 days, `CLAIM_WINDOW_SECS` = 10 s / 14 days.

New / changed instructions (all take the lease mint's `token_program`; the Anchor client fills PDAs):

| Instruction | Signers | Accounts beyond lease |
|---|---|---|
| `release_deposit(deduction)` | landlord | unchanged (vault, both ATAs, both profiles) |
| `accept_deduction()` | tenant | mint, vault, tenant_ata, landlord_ata, tenant_profile, landlord_profile |
| `abandon_dispute()` | tenant | none (moves no money) |
| `finalize_deduction()` | landlord | same as `release_deposit` |
| `settle_dispute(deduction)` | tenant **and** landlord | mint, vault, both ATAs, both profiles |
| `mark_default()` | landlord | **new account:** `landlord_profile` (A1) |

`Lease` gained `proposed_deduction: u64`, `disputed_at: i64`, `claim_pause_secs: i64`,
`dispute_rejected: bool`. `Status` gained `Disputed` (last variant, so existing values are unchanged).

### Transition table

`end` = `start + term*period`. `D` = `disputed_at`. Every row names who can act and what moves.

| State | Action (signer) | Condition | Result | Money |
|---|---|---|---|---|
| Active, all paid | `release_deposit(0)` (landlord) | `now >= end` | Closed | full deposit to tenant |
| Active, all paid | `release_deposit(d>0)` (landlord) | `now >= end`, `d <= deposit`, not previously rejected | **Disputed** | none |
| Active, all paid | `release_deposit(d>0)` (landlord) | tenant already rejected once | error `DisputeAlreadyRejected` | none |
| Active, all paid | `claim_deposit` (tenant) | `now >= end + CLAIM_WINDOW + claim_pause_secs` | Closed | full deposit to tenant |
| Active, unpaid | `mark_default` (landlord) | overdue past period + grace | Defaulted | owed rent (capped) to landlord, rest to tenant |
| Disputed | `accept_deduction` (tenant) | any time | Closed | `deposit - proposed` to tenant, `proposed` to landlord |
| Disputed | `settle_dispute(d)` (tenant + landlord) | any time, `d <= deposit` | Closed | `deposit - d` to tenant, `d` to landlord |
| Disputed | `abandon_dispute` (tenant) | `now < D + DISPUTE_WINDOW` | Active (`dispute_rejected = true`, proposal void, `claim_pause_secs += now - D`) | none |
| Disputed | `abandon_dispute` (tenant) | `now >= D + DISPUTE_WINDOW` | error `DisputeWindowClosed` | none |
| Disputed | `finalize_deduction` (landlord) | `now >= D + DISPUTE_WINDOW` | Closed | `deposit - proposed` to tenant, `proposed` to landlord |
| Disputed | `finalize_deduction` (landlord) | `now < D + DISPUTE_WINDOW` | error `DisputeWindowOpen` | none |
| Disputed | `claim_deposit`, `mark_default`, `release_deposit` | | error `WrongStatus` (the claim clock is paused) | none |
| Closed / Defaulted | anything | | error `WrongStatus` | none |

Why nothing is stuck: from `Disputed` the tenant can always end it (`accept_deduction`, or
`abandon_dispute` inside the window) and the landlord can always end it after the window
(`finalize_deduction`). The two exits are independent. `accept_deduction` deliberately has **no
deadline**: it pays exactly what the landlord proposed, so it can never hurt the landlord, and if it
expired with the window a landlord who proposed and vanished would leave only `finalize_deduction`
(theirs) to move the deposit. A landlord who never proposes anything is covered by `claim_deposit`.
`settle_dispute` is the only path with a free amount, because it is the only one both parties sign.

### Claim clock

`claim_deposit` is allowed at `end + CLAIM_WINDOW_SECS + claim_pause_secs`. While `Disputed` the status
check blocks it. `abandon_dispute` adds the seconds spent disputing to `claim_pause_secs`, so the
tenant waits exactly as long as they would have without the proposal: neither reset nor skipped, and a
landlord gains no extra delay by disputing.

### Trade-off (read this before presenting D1)

A tenant who explicitly rejects gets the **whole deposit** back through `claim_deposit`, even if there
was real damage. That is the price of no unilateral deduction without an oracle: the program cannot
know who is right. The landlord's remedies are `mark_default` (unpaid rent during the term), the
permanent rejection on the public record, a negotiated `settle_dispute`, and the roadmap appraiser
flow (D2, not built). `dispute_rejected` stops a landlord re-disputing every time the claim comes due
(which would keep the deposit out of reach forever); `release_deposit(0)` stays available so a
landlord can still choose a full return.

### Reputation fields (A1/A2)

`Profile` gained `last_deposit_return_bps: u16` (0-10000) and `deposit_events: u32`. All exits that
move the deposit (`release_deposit(0)`, `accept_deduction`, `finalize_deduction`, `settle_dispute`,
`claim_deposit`, `mark_default`) update both profiles' `deposit_total`, `deducted_total`, rate and
event count, except `mark_default`, which updates the **landlord's** only (the seizure used to be
missing there, which let a landlord who always defaults tenants show a perfect return rate).
`claim_deposit` records 10000 bps but bumps `deposits_claimed`, not `deposits_returned_full`.
bps = `(deposit - deduction) * 10000 / deposit` in u128, rounded down, and a zero deposit is 10000.

Account sizes (for the backend's rent-dust sizing, `8 + INIT_SPACE`, pinned by a Rust test):
`Application` **104 B** (unchanged), `Profile` **94 B** (was 88). `Lease` is now **218 B** (was 193); the
landlord pays it and the backend does not size it.

## 6. Known gaps

| Gap | Where |
|---|---|
| The settled confidential amount is unverified on chain | by design, `docs/privacy.md` |
| Deposit amount and deduction are public by design (the return-% reputation depends on it):  `fund_deposit` moves a public amount into the vault, and `release_deposit` / `claim_deposit` / `mark_default` pay out publicly | settled, `docs/privacy.md`. The vault is a PDA-owned token account and a PDA cannot hold ElGamal keys, so its balance cannot be confidential. Only rent is private |
| `init_config` is first-caller-wins | acceptable for a demo; `set_admin` is the recovery path |
| The confidential **accept** path is not covered on chain by `make test-demo` | a confidential `Transfer` needs real ZK proofs, which the local suite cannot produce: with a dummy payload the transfer fails inside Token-2022 *before* `pay_rent` runs, so any assertion about `pay_rent`'s behaviour would pass for the wrong reason. Covered instead by 10 Rust unit tests over the matcher in `programs/relstate/src/instructions/pay_rent.rs`, and end to end by the Phase 1 exit-gate devnet run |

### For Lane B: keep enough public rUSDC to fund a deposit

`docs/contracts/treasury.md` has the backend mint rUSDC to the tenant and then sponsor `deposit`
+ `apply pending`, which moves the balance into the confidential side. `fund_deposit` needs a
**public** balance, so a tenant whose whole balance is confidential cannot accept a lease — the
`transfer_checked` into the vault fails with insufficient funds.

So either hold back `lease.deposit_amount` from the confidential move, or withdraw that much back
to the public balance before `fund_deposit`. Only rent needs to be confidential.
