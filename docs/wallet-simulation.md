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
- **Compute budget.** No transaction here sets one, so the runtime default applies. A missing
  compute-budget instruction does not fail a simulation, and adding one would change the input to
  the sponsor's `worstCaseFeeLamports` cap for no benefit (`backend/src/txinspect.ts`).

## The fix

`adapterWallet()` in `app/src/lib/wallet.ts` now signs through the wallet's Wallet Standard
interface directly, passing `chain`. The wire handling is the adapter's, byte for byte; the only
difference is the field the adapter leaves out.

The cluster comes from `CLUSTER` in `app/src/lib/config.ts`. It cannot be read off the RPC URL,
because with a backend configured that URL is the backend's own read-only proxy and says nothing
about what is behind it — so `VITE_CLUSTER` is the explicit answer, and without it the app assumes
the two clusters the demo runs on: localnet when it already knows it is local (`VITE_LOCAL=1`),
devnet otherwise. **Never mainnet by guess**: naming the wrong cluster makes the wallet's prediction
wrong, which is worse than the warning this removes. Set `VITE_CLUSTER` on anything else.

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
