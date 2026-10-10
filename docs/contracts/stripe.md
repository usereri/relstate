# Fiat in: Stripe test mode (workstream E)

Stands in for a production on-ramp (Ramp/Transak/MoneyGram), which settle on mainnet. Test mode only: no real money, devnet USDC. State this on stage.

Flow
1. App: `POST /api/onramp/checkout { amountPln, depositHoldbackUsdc? }` (session required) -> backend prices the top-up, stores an **intent**, creates a Stripe Checkout Session (PLN; see "BLIK" below) with `metadata.wallet`, returns `{ url, intent, amountPln, amountUsdc, plnPerUsdc, simulated }`.
2. User pays with a test card (4242 4242 4242 4242) in Stripe's hosted page, returns to `APP_URL/#/app?tab=wallet&topup=done&intent=…`.
3. `POST /api/webhooks/stripe`: verify signature with `STRIPE_WEBHOOK_SECRET`, handle `checkout.session.completed` once per event id (idempotent), emit `ProviderEvent { kind: "onramp.completed", wallet, ref: eventId, amountUsdc }` (Contract 4).
4. Backend: `treasury.creditReserve(amount)` then mints (see "Where the confidential move happens").
5. Rate: fixed demo rate PLN->USDC in env (`DEMO_PLN_PER_USDC`), shown as illustrative.

Off-ramp: `POST /api/offramp/payout` (session required) -> a receipt labelled `simulated`. No money moves.
Reuse: `Provider` interface in `backend/src/contracts.ts`, mock provider in `backend/src/providers/index.ts`.

## Routes

| Route | Auth | Does |
|---|---|---|
| `GET /api/onramp/config` | public | rate, min/max PLN, per-wallet daily cap, whether the checkout is simulated. Lets the UI avoid hardcoding the rate |
| `POST /api/onramp/checkout` | session | prices and stores an intent, returns the hosted-page URL. **Cannot credit anything** |
| `GET /api/onramp/status?intent=` | session | `pending` \| `credited` \| `rejected`, plus the credit record. 404 for another wallet's intent, without confirming it exists |
| `POST /api/webhooks/stripe` | signature | **the only trusted trigger.** Idempotent per provider event id |
| `GET /mock/onramp?intent=&back=` | none | mock mode only: the stand-in for the hosted page |
| `POST /api/offramp/payout` | session | simulated payout receipt |
| `GET /api/offramp/history` | session | this wallet's receipts |

## What is trusted, and what is not

The browser can ask for a Checkout Session and nothing else. In particular:

- **The amount comes from the provider event**, never from a request body. For Stripe that is `amount_total` on the signed `checkout.session.completed`; for the mock it is the intent priced server-side at checkout time. A request claiming an `amountUsdc` changes nothing.
- **The wallet comes from the session token** at checkout time and travels to the webhook inside `metadata.wallet`, which Stripe signs. No request can credit someone else's wallet.
- **The return redirect credits nothing.** It is a URL the user can edit, so the app treats it only as a cue to poll `GET /api/onramp/status`. The webhook and the redirect race, and either order is normal.
- **One event credits once**, keyed on the vendor's event id (`ProviderEvent.ref`). Stripe may deliver the same event more than once; a duplicate that arrives while the first is still minting waits on it rather than starting a second mint.
- **Per-wallet daily cap** (`ONRAMP_MAX_USDC_PER_WALLET_PER_DAY`), checked at checkout to fail fast and again at credit time, which is the one that counts. A credit over the cap is recorded as `rejected` and returns 200: the money was taken, and a retry would not change the answer.
- **A wrong currency is refused, not converted.** A session that settled in anything but PLN would be priced against a PLN rate.
- **No secret is ever logged**, including in an error path: the Stripe error message is returned, the request body and the key are not.

The rate is pinned into the session metadata at checkout, so changing `DEMO_PLN_PER_USDC` cannot alter what an already-paid session is worth.

### Signature verification

`t=<unix>,v1=<hex>` over `${t}.${rawBody}`, HMAC-SHA256 with the endpoint secret, compared in constant time, within `STRIPE_WEBHOOK_TOLERANCE_SECONDS` (default 300). Only `v1` is accepted. The route reads the **raw body text** — re-serialising the JSON changes the hash and the signature fails, which is tested.

## Where the confidential move happens

`treasury.wrapAndMakeConfidential` needs the tenant's signer and ElGamal keys: `Deposit` and `ApplyPendingBalance` are owner-signed and the latter re-encrypts the balance locally. The webhook runs with no user present and nobody here holds a user's key, so the webhook does the half it can:

1. `treasury.creditReserve(amount)` — the USDC leg (a counter in mock mode, a log in live mode).
2. `treasury.wrap({ wallet, amount })` — mints rUSDC to the **public** balance, which needs only the treasury's mint authority.
3. records the split from `confidentialMoveAmount(amount, publicHoldback)` as `confidentialAmount` with `confidentialPending: true`.

The app finishes step 3 with the wallet's own keys over a sponsored transaction. `depositHoldbackUsdc` on the checkout request is the lease deposit, which must stay **public** for `fund_deposit` (`treasury.md`, "Keep the deposit public"); a plain top-up leaves it at zero. A holdback larger than the top-up is rejected at checkout; if it somehow reaches the webhook it is clamped and logged, because the money has already been taken and must not be stuck.

`createOnramp` takes an optional `resolveOwner` seam: when a caller *does* hold the owner's signer and keys — tests, the scripted devnet run — the credit goes through `wrapAndMakeConfidential` in full and reports `confidentialPending: false`. Production wiring leaves it unset.

## Mock mode is the default, and needs no secrets

With `ONRAMP_PROVIDER` unset the checkout URL points at `GET /mock/onramp`, a page this backend serves. It shows the server-priced amounts and its button posts `{ intent }` to the same `POST /api/webhooks/stripe` route — so the demo and the real flow differ only in which provider verifies the payload, not in what happens afterwards. The amount is still not in that request.

Two things that page gets right, because both were bugs first:

- the intent id and return URL are embedded with `jsonForScript`, which escapes `<` so a value containing `</script>` cannot close the block;
- `back` is validated by **origin** (`safeReturnBase`), not by prefix — `http://localhost:5173.evil.test/` starts with the app URL and is a different site.

## Payment methods

The backend does not name payment methods: Stripe now rejects `payment_method_types` on Checkout Sessions and offers whatever is enabled under Dashboard > Settings > Payment methods. Verified 2026-10-10 on our test account: a PLN session offers card, BLIK, Link and Klarna. Test BLIK uses the code 777123 in test mode.

## Honest framing for the stage

- Test mode: the card is fake, the money is fake, and the USDC behind the peg is devnet test USDC.
- The peg is a custodial promise backed by a reserve we control, and the invariant `rUSDC supply <= reserve` is enforced on every mint (`treasury.md`).
- The payout is simulated. rUSDC is burnt with the **landlord's** signature, which this backend deliberately cannot produce on their behalf, so a payout made without it releases nothing from the reserve and the receipt says so.
