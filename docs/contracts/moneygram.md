> **PARKED 2026-10-09.** MoneyGram's Solana ramp is cash-counter only (card/bank on-ramp is announced, undated) and our sandbox key returns 401. Demo fiat-in is Stripe test mode: see `stripe.md`. Notes below kept for a post-demo cash-out integration.

# MoneyGram Ramps (workstream E) — spike findings, 2026-10-09

Sources: MoneyGram developer pages, the Solana Foundation template `community/moneygram-onramp`, and a live call with our sandbox keys.

## What it is
- **Cash <-> USDC at MoneyGram counters**, not card/bank. Cash-in: user deposits cash, gets a counter confirmation code, MoneyGram delivers USDC. Cash-out: user commits in the widget, signs a USDC transfer, gets a cash pickup code.
- **No server SDK.** A browser script (`<origin>/sdk/index.global.js`) exposes `window.RampsSDK.createRamps(config)`, which renders an iframe widget. The only server call is session creation.
- Sandbox origin: `https://playground.xramps.moneygram.com` (devnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`).

## Flow
1. Server: `POST {origin}/api/v1/sessions`, header `x-api-key: <ramps_sk_sbox_…>`, body `{}` -> `{ sessionToken, sessionId, widgetUrl }`. Public keys (`ramps_pk_*`) are refused: "Session creation requires a secret key".
2. Browser: load the SDK script, `createRamps({ container, sessionToken, widgetUrl (+ ?mode=on-ramp|off-ramp), wallet: { address, chain: "solana", asset: "USDC", walletType }, transaction: { type, asset, amount?, destinationCountry?, destinationCurrency? }, onSignTransaction, onComplete, onError, onClose })`, then `.open()`.
3. On-ramp: no signing. USDC arrives at `wallet.address` after the cash deposit is processed. `onComplete` gives `{ id, referenceNumber, status, amount }`.
4. Off-ramp: widget calls `onSignTransaction({ to, amount (decimal string), tokenAddress, tokenDecimals, memo, requiredNetwork })`; app sends a USDC transfer to `to` and returns the signature.

## Consequences for our design
- **Demo story fits the nomad pitch** (cash in, cash out, no bank account) but the "pay local fiat by card" story does not apply.
- **Tenant top-up:** MoneyGram pays USDC to a wallet we name. Decision needed: (a) tenant's embedded wallet, then the backend wraps by moving that USDC into the treasury reserve, or (b) the treasury reserve directly, with the backend crediting rUSDC to the tenant. (b) is simpler and matches treasury.md, but ties the widget's `wallet.address` to the treasury, which the widget may treat as the user's own wallet.
- **Landlord cash-out:** needs public devnet USDC in a wallet that can sign. After `unwrap`, the reserve releases USDC to the landlord wallet, then `onSignTransaction` transfers it. The landlord's embedded wallet must be able to sign (sponsored fees apply).
- **Confirmation:** no webhook documented in anything we could read. Plan on `onComplete` plus polling the destination USDC balance.
- Deposit/rent amounts through MoneyGram are public USDC; privacy starts at the rUSDC wrap.

## Unknowns
- Sandbox currencies/countries, limits, how a sandbox cash-in "completes" without a real counter, webhook/status API, production endpoints. The developer portal (`xramps.moneygram.com/ops/developer`) returns 403 to unauthenticated fetches; read it logged in.

## Spike result
`spikes/moneygram/session.mjs` with our keys (format `ramps_sk_sbox_` / `ramps_pk_sbox_`): private key -> **401 Invalid API key**; public key -> 403 (expected). The key is well-formed, so it is probably not yet activated, mistyped, or tied to another sessions URL. Not resolved. Template's `MONEYGRAM_SESSIONS_URL` comment: "override if MoneyGram gives you another".
