# Fiat in: Stripe test mode (workstream E)

Stands in for a production on-ramp (Ramp/Transak/MoneyGram), which settle on mainnet. Test mode only: no real money, devnet USDC. State this on stage.

Flow
1. App: `POST /api/onramp/checkout { amountPln }` (session required) -> backend creates a Stripe Checkout Session (PLN; card, plus BLIK if test mode supports it) with `metadata.wallet`, returns `{ url }`.
2. User pays with a test card (4242 4242 4242 4242) in Stripe's hosted page, returns to the app.
3. `POST /api/webhooks/stripe`: verify signature with `STRIPE_WEBHOOK_SECRET`, handle `checkout.session.completed` once per event id (idempotent), emit `ProviderEvent { kind: "onramp.completed", wallet, ref: eventId, amountUsdc }` (Contract 4).
4. Backend: `treasury.creditReserve(amount)` then `treasury.wrapAndMakeConfidential({ wallet, amount, publicHoldback })` (see treasury.md; keep the lease deposit public).
5. Rate: fixed demo rate PLN->USDC in env (`DEMO_PLN_PER_USDC`), shown as illustrative.
Off-ramp: mocked payout screen; no money moves.
Reuse: `Provider` interface in backend/src/contracts.ts, mock provider in backend/src/providers/index.ts.
