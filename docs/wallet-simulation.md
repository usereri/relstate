# Why Phantom said "this transaction reverted during simulation"

A hand test of the demo found Phantom showing

> This transaction reverted during simulation. Funds may be lost if submitted.

over transactions that then succeeded. This is what caused it, what fixes it, and the one case
where the warning is expected and cannot be removed from our side.

## The cause: nothing told the wallet which cluster it was on

A wallet simulates whatever it is asked to sign, so it can show the user the balance changes it
predicts. Which cluster it simulates against is **not** something it can infer from the transaction
— a transaction carries no network — so the Wallet Standard puts it in the request:

```ts
// @solana/wallet-standard-features
signTransaction({ account, transaction, chain? /* 'solana:devnet' … */ })
```

`chain` is optional, and `StandardWalletAdapter.signTransaction` does not send it:

```js
// @solana/wallet-standard-wallet-adapter-base, #signTransaction
await wallet.features['solana:signTransaction'].signTransaction({
    account,
    transaction: /* serialized */,
});   // ← no chain
```

Its `sendTransaction` *does* (`getChainForEndpoint(connection.rpcEndpoint)`), but this app cannot
use `sendTransaction`: every transaction is fee-paid by the sponsor, so the app signs it and posts
it to `POST /api/sponsor`, which validates it, co-signs as fee payer and submits
(`app/src/lib/chain.ts`, `sendSponsored`). The signing path is therefore the one that never named a
cluster.

With no cluster named the wallet falls back to its own default. Simulated against mainnet, nothing
in a relstate transaction exists — not the program id, not the test mint, not one lease, vault or
profile PDA — so the simulation fails, and the wallet reports that failure in the only words it
has for it. The transaction is fine; it is being simulated against the wrong chain.

This is also why it appeared on *some* transactions and not others: the warning is shown when the
simulation errors, and only the browser-extension path goes through a wallet at all. The built-in
test wallets and the email/embedded wallet hold their keys in the page and sign without simulating
anything, so neither ever showed it.

### What it was not

Worth recording, because each was a plausible suspect and each was checked:

- **The empty fee-payer signature slot.** The sponsor's signature is deliberately missing when the
  user signs (`docs/env-checklist.md`, contract 2). A wallet has to simulate with signature
  verification off regardless — the user has not signed yet either — so an unsigned slot does not
  fail a simulation.
- **Blockhash or ordering.** The blockhash comes from the same RPC the app reads through, and the
  backend keeps it (`replaceRecentBlockhash: false`) so an expired one fails before we pay.
- **The confidential-transfer proof plan.** Its transactions are genuinely dependent — each reads
  the context-state accounts the one before created — but `sponsoredSubmit` confirms each before
  building the next (`app/src/lib/confidential.ts`), so the accounts exist by the time the wallet
  sees the transaction that uses them.
- **Compute budget.** A missing compute-budget instruction does not fail a simulation. The
  sponsored Anchor flows now set one anyway, for a different reason: see
  [Compute budget](#compute-budget-the-wallet-adds-one-if-the-app-does-not) below.

## The fix

`adapterWallet()` in `app/src/lib/wallet.ts` now signs through the wallet's Wallet Standard
interface directly, passing `chain`. The wire handling is the adapter's, byte for byte; the only
difference is the field the adapter leaves out.

The cluster comes from `CLUSTER` in `app/src/lib/config.ts`, and **the app names one only when it
knows it**; otherwise it names none and the wallet behaves exactly as it did before this change
(it simulates against the network the user selected in it, which is right whenever that is the
app's network). It cannot be read off the RPC URL in general, because with a backend configured that
URL is the backend's own read-only proxy and says nothing about what is behind it. So:

| What the app knows | Cluster named |
|---|---|
| `VITE_CLUSTER` set | that one |
| `VITE_LOCAL=1`, the default Surfpool endpoint (no backend, no `VITE_RPC`), or an unproxied RPC on a loopback host | `solana:localnet` |
| an unproxied `VITE_RPC` that names devnet, testnet or `api.mainnet-beta.solana.com` | that one |
| anything else: a proxied backend, a keyed provider URL | **none** |

**Never guess.** Naming devnet for a proxied or keyed RPC would make a mainnet deploy's wallet
simulate against the wrong chain, which reintroduces this exact warning in the one environment where
saying nothing already worked. A deploy whose RPC is proxied therefore **must set `VITE_CLUSTER`**
to get the fix (including the hosted devnet demo); without it, it behaves as before.

Nothing about the sponsor's checks changes. The app still signs a transaction whose fee-payer slot
is empty and still posts it to `/api/sponsor`, which still runs every static check and its own
simulation before it signs (`backend/src/sponsor.ts`, steps 1–10). The fix is entirely in what the
app tells the wallet about the network.

### Fallbacks, so this cannot make things worse

The chain-aware path is used only when the connected wallet can actually serve it: it offers
`solana:signTransaction`, the connected key is one of its accounts, and **that account claims the
cluster**. A wallet that does not list `solana:localnet` among an account's chains would refuse a
request naming it, and a refusal is worse than a warning — so any of those falls back to the
adapter's existing chain-less call, which is the behaviour that shipped before this change.

### Errors keep the adapter's shape

The adapter wraps every signing failure — the user pressing Reject included — as
`WalletSignTransactionError` (and a vanished account as `WalletNotConnectedError`), and
`chain.errorMessage` keys its wallet guidance ("set to the same network as this app…") on that
`Wallet…` name. The chain-aware signer does the same wrapping, so that guidance still appears.

## Compute budget: the wallet adds one if the app does not

Phantom rewrites a transaction it is asked to sign when that transaction sets no compute budget: it
prepends `SetComputeUnitLimit` and `SetComputeUnitPrice` of its own choosing. On the hosted devnet
demo, a "publish listing" transaction the app built with one instruction came back from Phantom
with three. The price it chose was 375,000 micro-lamports per unit, and two things followed:

- **The sponsor refused it.** `SPONSOR_MAX_CU_PRICE_MICROLAMPORTS` defaults to 10,000, so the
  request failed with `requested 375000 micro-lamports per unit, cap is 10000`
  (`backend/src/txinspect.ts`, `assertComputeBudgetWithinPolicy`). Raising the cap let it through,
  but it also let the wallet, not the app, decide what the sponsor pays.
- **The prompt was slow.** Phantom took over 30 seconds to show the signature request; the app
  measured 34.8 s from setting the blockhash to getting the signed transaction back, approval
  included. That request then failed at the sponsor with `simulation failed: "BlockhashNotFound"`.
  A blockhash normally stays valid for 60–90 seconds, so the wait alone does not obviously explain
  the failure, and neither is it confirmed that Phantom spends that time on the budget. Both are
  open; the console log below is how to tell once this change is deployed.

So `sendSponsored` (`app/src/lib/chain.ts`) now prepends a budget before the wallet sees the
transaction, through `withComputeBudget`, and leaves alone a transaction that already has one:

| Instruction | Value | Why |
| --- | --- | --- |
| `SetComputeUnitLimit` | 200,000 per instruction, at most 400,000 | the runtime's own default for one or two instructions; 400,000 is the sponsor's default `SPONSOR_MAX_COMPUTE_UNITS`, and the sponsor already refused any simulation that consumed more |
| `SetComputeUnitPrice` | 1,000 micro-lamports | inside the sponsor's default 10,000 cap; adds at most 400 lamports to the fee |

The worst case, two signatures plus the priority fee, is 10,400 lamports, inside the default
`SPONSOR_MAX_FEE_LAMPORTS` of 200,000, so a backend left at its defaults accepts every sponsored
Anchor transaction. The test `withComputeBudget` in `app/src/lib/__tests__/chain.test.ts` pins these
against the defaults. The two instructions add about 50 bytes; the largest listing, with every text
field at its maximum, stays under 800 of the 1,232 allowed.

`sendSponsored` also logs to the browser console: one `[sponsor]` line per transaction with its
blockhash and how long the wallet took to sign, and a warning if the wallet still changed the
blockhash or the instructions. If that warning appears, this section is incomplete.

Not covered: the confidential-transfer transactions (`app/src/lib/confidential.ts`,
`sponsoredSubmit`) go to the wallet through their own path and set no budget, so a wallet may
still add one there. The treasury routes that co-sign them (account setup and rent payment,
`backend/src/treasury.ts`) apply the same `SPONSOR_MAX_*` caps, so a wallet-chosen price above
the cap is refused there too.

## The case that remains: a local validator

On a **localnet** demo the warning may persist, and that is not fixable here.

A wallet's simulation runs on the wallet vendor's own infrastructure, not in the browser. Surfpool
listens on `127.0.0.1:8899` on the demo machine, which no external simulator can reach. So on
localnet a wallet either skips the simulation (no estimate, no warning) or fails to reach the chain
and reports it as a failure. Naming `solana:localnet` is the honest request and is what the app now
sends; what the wallet does with it is the wallet's.

Two ways around it, in order of preference:

1. **Run the hand test on devnet**, which is where the hosted demo and the pitch run anyway. There
   the cluster is reachable, the accounts exist, and the simulation passes.
2. **Use the built-in test wallets** on localnet (the "Test wallet" entry in Connect wallet, local
   networks only). They hold their key in the page and never simulate, which is why the local demo
   flow never showed this warning in the first place.
