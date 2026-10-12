# Environment variable checklist

Every variable the demo deployment touches, derived from [`.env.example`](../.env.example),
[`app/.env.example`](../app/.env.example), [`site/.env.example`](../site/.env.example) and
[`backend/src/env.ts`](../backend/src/env.ts). Grouped by where it actually lives once deployed, not
by file, since that's the question this checklist exists to answer. Read with
[`docs/deploy.md`](deploy.md), which is the step-by-step procedure; this page is the reference you
come back to when a route 500s with "invalid configuration" or a build ships the wrong default.

**Live mode on the hosted demo:** `BACKEND_MODE=live` refuses `AUTH_MODE=mock`. Use
`AUTH_MODE=wallet` (users sign a one-time challenge with their wallet; no third party) and set
`APP_URL` (challenges are bound to its origin). `KYC_PROVIDER=mock` is refused in live mode unless
**both** `ALLOW_MOCK_KYC=devnet` and `SOLANA_CLUSTER=devnet` are set, and the RPC's genesis hash
confirms devnet at boot; the backend then logs a loud warning. Mock KYC still writes the real
on-chain Attestation; it only skips document verification. Anything else refuses to boot.

## Legend

| | |
|---|---|
| **Where** | `Fly secret` (`fly secrets set`, encrypted, never in `fly.toml`) · `Fly env` (`[env]` in `fly.toml`, plain text, fine for non-secrets) · `GH Pages var` (GitHub repo Settings → Secrets and variables → Actions → **Variables** tab — not Secrets, see below) · `local .env` (dev only, never deployed) |
| **Public?** | Every `GH Pages var` is **public**: it is compiled into the static JS bundle anyone can read. A `Fly secret` is never logged or returned by any route. |

## Backend (Fly)

### RPC

| Variable | Where | Public? | Required | Example |
|---|---|---|---|---|
| `SOLANA_CLUSTER` | Fly env | public | optional (default `devnet`) | `devnet` |
| `HELIUS_API_KEY` | Fly secret | **secret** | strongly recommended (public devnet RPC 429s under the proof plan) | `a1b2c3d4-...` |
| `RPC_URL` | Fly env | public | only if `HELIUS_API_KEY` is unset | `https://api.devnet.solana.com` |
| `RPC_MAX_RETRIES` / `RPC_RETRY_BASE_MS` / `RPC_RETRY_MAX_MS` | Fly env | public | optional (sane defaults) | `8` / `500` / `20000` |

### Backend core

| Variable | Where | Public? | Required | Example |
|---|---|---|---|---|
| `PORT` | Fly env (also hardcoded in `backend/Dockerfile`) | public | optional (default `8787`) | `8787` |
| `BACKEND_MODE` | Fly env | public | `mock` or `live` | `live` |
| `AUTH_MODE` | Fly env | public | optional (default `mock`; `live` mode refuses `mock`; use `wallet` for real login) | `wallet` |
| `WALLET_SESSION_TTL_SECONDS` / `AUTH_CHALLENGE_TTL_SECONDS` / `AUTH_RATE_PER_MINUTE` | Fly env | public | optional, `AUTH_MODE=wallet` only (defaults `43200` / `300` / `20` per IP per route) | `43200` |
| `SESSION_SECRET` | Fly secret | **secret** | required when `BACKEND_MODE=live`; a random per-process one is used in mock mode | 32+ random bytes, base64 (live refuses <32 chars or trivial values). **Never share it between a mock and a live deployment** (tokens are also domain-separated by `AUTH_MODE`, as defence in depth) |
| `SESSION_TTL_SECONDS` | Fly env | public | optional (default `3600`) | `3600` |
| `ADMIN_TOKEN` | Fly secret | **secret** | required when `BACKEND_MODE=live`; guards `/api/treasury/wrap` and `/credit-reserve`; live refuses <32 chars or trivial values | 32+ random bytes |
| `INVITE_EMAIL_SENDER` | Fly env | public | optional: `console` or `none`. Blank picks `console` in mock mode and `none` in live mode, so a live deployment never claims to have sent mail it cannot send | `none` until a provider is wired |
| `INVITE_TTL_SECONDS` | Fly env | public | optional; blank follows the program's `SELECTION_WINDOW_SECS` from the IDL. The expiry is clamped to the dispute's `selection_deadline` either way, so a link can never outlive the window in which the wallet it carries could still be bound | |

**What the backend can do in a mediation, which is almost nothing.** Revision 2 of mediation removed the appraiser registry and the verdict console, so there is **no backend-held key that can decide a deposit** and no admin instruction anywhere in mediation (`docs/contracts/dispute-mediation.md` §10 items 1 and 8). The parties agree on a company *name* on chain; the appraiser signs the verdict with a wallet of their own, created when they open the invitation and log in. `APPRAISERS`, `APPRAISER_KEYPAIRS`, `VERDICT_CONSOLE_TOKEN`, `VERDICT_CONSOLE_LEASES`, `GET /api/appraisers`, `POST /api/admin/appraiser/verdict` and `scripts/setup-appraisers.ts` are all gone; delete them from any `.env` and `fly secrets unset` them.

**What an invitation is, and what it is not.** `POST /api/invites` is callable only by the landlord or the tenant of the lease, only while it is in `Mediation`, and only for the company name whose hash matches `dispute.agreed_name_hash` — checked by hashing the name exactly as the program does. The invite token is HMAC-signed with its own key (`relstate/invite/v1`, derived from `SESSION_SECRET`), bound to lease + name hash, single-use, and expires no later than `selection_deadline`. `GET /api/invites/:token` is public, because the recipient has no account yet, and rate-limited per IP.

**An invite is an off-chain assertion, not an authorisation.** Nothing in this flow can bind an appraiser or move money: after the appraiser claims the invite, *both* parties still read the wallet (`GET /api/invites?lease=…`) and each calls `propose_appraiser_key` / `confirm_appraiser_key` themselves. The program's guarantee stays exactly "both parties confirmed this wallet", never "this wallet is that company" (§10 item 3) — so if the e-mail were intercepted, or this backend lied about the wallet, the parties would be confirming a key that is not the company's and the program could not tell. That is why the confirmation is a human step on both sides.

**Blast radius of this backend being fully compromised, in a mediation:** it can issue invitations for leases that are in mediation to addresses of its choosing, and can report a wallet of its choosing as the claimed one. It **cannot** bind that wallet (both parties must confirm), submit a verdict (it holds no appraiser key), end a mediation, or choose the company name (that is agreed on chain before any invite is possible). A party's e-mail address is write-only: it is used to send and is never returned by any route, so neither the appraiser nor the other party can read it.

**Rent the sponsor pays for a verdict, which is not covered by the sponsor's lamport caps.** The verdict transaction carries an idempotent create-ATA for the appraiser's token account, paid by the fee payer, because that wallet has no SOL. `SPONSOR_MAX_FEE_LAMPORTS` and the per-wallet daily lamport caps count *fees*, and this rent is debited by the System program inside the instruction, so it is **not** booked against them. What bounds it instead is structural (`txinspect.sponsorFundedAtaInstructions`): the sponsor may be named only in that one instruction, the account created must be the canonical ATA of the wallet signing the verdict for the lease's own mint, there may be at most one, and the whole transaction reverts if the verdict fails — so no rent leaves the sponsor unless a valid verdict lands with it. The exposure is one token-account rent per lease that actually reaches a verdict.
| `CORS_ORIGIN` | Fly env | public | **set to `https://<your domain>`** (never leave as `*` once live) | `https://relstate.example` |
| `RELSTATE_IDL` | Fly env (baked into `backend/Dockerfile`) | public | set by the image, not by you | `/app/app/idl/relstate.json` |
| `APP_URL` | Fly env | public | **set to `https://<your domain>/app/`** — Stripe's return redirect and the mock on-ramp page both use it | `https://relstate.example/app/` |

### Keys (four separate keys — never reuse one, `docs/contracts/treasury.md`)

| Variable | Where | Public? | Required | Format |
|---|---|---|---|---|
| `FEE_PAYER_KEYPAIR` | Fly secret | **secret** | required when `BACKEND_MODE=live` | CLI keypair path, inline 64-byte JSON array, or base58 secret (`backend/src/keys.ts`) — use inline JSON or base58 on Fly, there is no file to point at |
| `ATTESTATION_ISSUER_KEYPAIR` | Fly secret | **secret** | required when `BACKEND_MODE=live`; must differ from the fee payer | same formats |
| `TREASURY_KEYPAIR` | Fly secret | **secret** | required when `BACKEND_MODE=live`; must differ from both of the above | same formats |
| `KYC_SUBJECT_SALT` | Fly secret | **secret** | required when `BACKEND_MODE=live` | any high-entropy string, kept stable |

### rUSDC (written by `scripts/make-rusdc.ts`)

| Variable | Where | Public? | Required | Example |
|---|---|---|---|---|
| `RUSDC_MINT` | Fly env | public (it's a mint address) | required when `BACKEND_MODE=live` | a base58 pubkey |
| `RUSDC_DECIMALS` | Fly env | public | optional (default `6`) | `6` |
| `RUSDC_AUDITOR_IKM` | Fly secret | **secret** | required when `BACKEND_MODE=live` | 32-byte base64 seed |
| `RUSDC_AUDITOR_ELGAMAL_PUBKEY` | Fly env | public (reference only, not read back) | optional | base58 |
| `USDC_RESERVE_MINT` | Fly env | public | optional (blank = mock reserve counter) | a base58 pubkey |
| `USDC_RESERVE_TOKEN_ACCOUNT` | Fly env | public | optional (blank = mock reserve counter) | a base58 pubkey |

### Sponsor caps, rent-payment caps, rent-dust caps

All optional with working defaults (`backend/src/env.ts`); set only to tune them. None are secret.
`Fly env` for all: `SPONSOR_MAX_TX_BYTES`, `SPONSOR_MAX_INSTRUCTIONS`, `SPONSOR_MAX_COMPUTE_UNITS`,
`SPONSOR_MAX_CU_PRICE_MICROLAMPORTS`, `SPONSOR_MAX_FEE_LAMPORTS`, `SPONSOR_MAX_RENT_LAMPORTS`,
`SPONSOR_MAX_PER_WALLET_PER_HOUR`, `SPONSOR_MAX_GLOBAL_PER_HOUR`,
`SPONSOR_MAX_LAMPORTS_PER_WALLET_PER_DAY`, `SPONSOR_MAX_LAMPORTS_GLOBAL_PER_DAY`,
`RENT_PAYMENT_MAX_CONTEXT_LAMPORTS`, `RENT_PAYMENT_MAX_CONTEXT_SPACE`,
`RENT_PAYMENT_MAX_CREATE_ACCOUNTS`, `RENT_PAYMENT_MAX_SPEND_LAMPORTS`,
`RENT_PAYMENT_MAX_PER_WALLET_PER_HOUR`, `RENT_PAYMENT_MAX_GLOBAL_PER_HOUR`,
`RENT_PAYMENT_MAX_LAMPORTS_PER_WALLET_PER_DAY`, `RENT_PAYMENT_MAX_LAMPORTS_GLOBAL_PER_DAY`,
`RENT_DUST_MAX_GLOBAL_PER_HOUR`, `RENT_DUST_MAX_LAMPORTS_GLOBAL_PER_DAY`. Defaults are in
`.env.example` and `backend/src/env.ts`; the comments there explain each number.

### Identity (KYC)

| Variable | Where | Public? | Required | Example |
|---|---|---|---|---|
| `KYC_PROVIDER` | Fly env | public | optional (default `mock`; `live` backend mode refuses `mock` unless `ALLOW_MOCK_KYC=devnet`) | `mock` |
| `KYC_MOCK_MAX_ATTESTS_PER_HOUR` / `KYC_MOCK_MAX_LAMPORTS_PER_DAY` / `KYC_MOCK_LAMPORTS_PER_ATTEST` | Fly env | public | optional; global fee-payer budget for mock-KYC attestations in live mode (defaults `20` / `20000000` / `4000000`) | `20` |
| `TRUST_PROXY_IP_HEADER` | Fly env | public | set `1` only if behind a proxy that sets `fly-client-ip`; automatic on Fly (`FLY_APP_NAME`) | `1` |
| `ALLOW_MOCK_KYC` | Fly env | public | only to run mock KYC in live mode; must be exactly `devnet`, requires `SOLANA_CLUSTER=devnet` and a devnet RPC (genesis-hash checked at boot) | `devnet` |
| `KYC_LEVEL` | Fly env | public | optional (default `1`) | `1` |
| `KYC_VALIDITY_DAYS` | Fly env | public | optional (default `365`) | `365` |
| `SUMSUB_APP_TOKEN` | Fly secret | **secret** | required when `KYC_PROVIDER=sumsub` | vendor token |
| `SUMSUB_SECRET_KEY` | Fly secret | **secret** | required when `KYC_PROVIDER=sumsub` | vendor secret |
| `SUMSUB_WEBHOOK_SECRET` | Fly secret | **secret** | required when `KYC_PROVIDER=sumsub` (a different secret from the one above) | vendor secret |
| `SUMSUB_API_BASE` / `SUMSUB_LEVEL_NAME` / `SUMSUB_LINK_TTL_SECONDS` / `SUMSUB_WEBHOOK_DIGEST_ALG` / `SUMSUB_WEBHOOK_MAX_AGE_SECONDS` / `KYC_MAX_STARTS_PER_WALLET_PER_HOUR` | Fly env | public | optional, only matter when `KYC_PROVIDER=sumsub` | see `.env.example` |

### Fiat in / out (Stripe test mode)

| Variable | Where | Public? | Required | Example |
|---|---|---|---|---|
| `ONRAMP_PROVIDER` | Fly env | public | optional (default `mock`) | `stripe` |
| `OFFRAMP_PROVIDER` | Fly env | public | always `mock` — a real cash-out settles on mainnet, out of scope | `mock` |
| `STRIPE_SECRET_KEY` | Fly secret | **secret** | required when `ONRAMP_PROVIDER=stripe` | `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | Fly secret | **secret** | required when `ONRAMP_PROVIDER=stripe` | `whsec_...` (from the TEST-mode dashboard endpoint, **not** `stripe listen`'s — see `docs/deploy.md`) |
| `STRIPE_PUBLISHABLE_KEY` | — | public | unused: the app never talks to Stripe directly, only the hosted Checkout page does | — |
| `STRIPE_API_BASE` / `STRIPE_WEBHOOK_TOLERANCE_SECONDS` | Fly env | public | optional | defaults are fine |
| `DEMO_PLN_PER_USDC` | Fly env | public | optional (default `4.30`), illustrative only | `4.30` |
| `ONRAMP_MIN_PLN` / `ONRAMP_MAX_PLN` | Fly env | public | optional | `10` / `5000` |
| `ONRAMP_MAX_USDC_PER_WALLET_PER_DAY` / `OFFRAMP_MAX_USDC_PER_WALLET_PER_DAY` | Fly env | public | optional | `2000` |

### Local only — never deployed

`LANDLORD_WALLET`, `TENANT_WALLET` (root `.env.example`) only feed `make demo-setup` on your own
machine; the hosted backend never reads them.

## App (GitHub Pages build, repository **Variables**)

Build-time only (Vite inlines `VITE_*` at `vite build` time), read from **Settings → Secrets and
variables → Actions → Variables**, not Secrets — anything here ends up in the public JS bundle
whether you hide it or not, so the Variables tab is the honest place for it.
`.github/workflows/pages.yml` fails with a clear error if a required one is missing.

| Variable | Public? | Required | Example / notes |
|---|---|---|---|
| `VITE_API` | public | **required** | `https://<your-fly-app>.fly.dev` |
| `VITE_RPC` | public | **leave unset** | the app reads through the backend's `/api/rpc` (read-only, rate limited), so no RPC key is in the bundle. Setting it ships that URL, key included, to every visitor |
| `VITE_CLUSTER` | public | **set it on the hosted demo** | the cluster named in every wallet signing request, so the extension simulates against the right chain and stops warning "this transaction reverted during simulation" over transactions that succeed (docs/wallet-simulation.md). The app names a cluster only when it knows one: this variable, or a local chain (`VITE_LOCAL=1`, the default Surfpool endpoint, a loopback RPC). With `VITE_API` the app's RPC is the backend's proxy and says nothing about the cluster, so **unset means none is named** and the wallet uses its own selected network, as before the fix. `devnet` \| `mainnet` \| `testnet` \| `localnet` |
| `VITE_RUSDC_MINT` | public | **required** | the mint `scripts/make-rusdc.ts` printed |
| `VITE_MINT` | public | **required** | the mint leases are settled in. For the confidential (private rent) demo it **must equal `VITE_RUSDC_MINT`**: the tenant holds and pays rUSDC, so a lease in another mint fails at "fund deposit" with `tenant_ata AccountNotInitialized`. The code default is a different machine's mint and will not exist on your network |
| `VITE_DEFAULT_PUBLIC_HOLDBACK` | public | optional | base units of every plain top-up kept public for the lease deposit; default `100000000` (100 rUSDC). See docs/contracts/treasury.md |
| `VITE_FEE_PAYER` | public | optional | blank is fine — the app then asks `GET /api/sponsor` for it |
| `VITE_EMBEDDED_WALLET` | public | fixed by the workflow to `mock` | not a repository variable — `.github/workflows/pages.yml` always builds with it set to `mock`, since Privy's SDK binding is not wired up yet (`app/.env.example`) |
| `VITE_APPRAISER_CONSOLE` | public | **obsolete — leave unset** | Served the operator verdict screen at `#/appraiser`, which signed a verdict with a backend-held key through `POST /api/admin/appraiser/verdict`. **That route and those keys no longer exist** (revision 2 of mediation: the appraiser signs with their own wallet). The flag now has nothing to talk to; the screen and this row go when the app drops them |
| `SITE_APP_URL` | public | **required** | `https://<your domain>/app/` — this is the site's link to the app, must include the trailing `/app/` |
| `CUSTOM_DOMAIN` | public | **required** | `relstate.example` — written verbatim into the Pages artifact's `CNAME` file |

`VITE_CT_PAYER` (`app/.env.example`) is a developer-only throwaway devnet keypair for
`confidential-check.html`; it is never set in CI or Pages, and must never be a real key if you ever
do set it locally — anything in a `VITE_` variable is compiled into the page.

## Site (GitHub Pages build, repository Variable)

| Variable | Public? | Required | Example |
|---|---|---|---|
| `SITE_APP_URL` | public | **required** (same variable as the app table above — one value feeds both builds) | `https://<your domain>/app/` |

## What works today when hosted with `BACKEND_MODE=mock`

Honest framing for the runbook's smoke test and for the pitch, given the blocker above:

- Sign-up/sign-in works through `POST /api/auth/mock` — not a real login, but it issues a real
  session token and every other route behaves exactly as it does in `live` mode.
- The real Stripe test-mode Checkout page works end to end if `ONRAMP_PROVIDER=stripe` and the two
  Stripe secrets are set: a real hosted payment page, a real signed webhook.
- **No on-chain minting happens from that webhook** in a way a real user's wallet can see, because
  `BACKEND_MODE=mock` keeps the reserve as an in-memory counter and the fee payer/treasury/issuer
  keys are ephemeral per process (regenerated on every restart) unless you explicitly set
  `FEE_PAYER_KEYPAIR` / `TREASURY_KEYPAIR` / `ATTESTATION_ISSUER_KEYPAIR` even in mock mode.
- Setting those three keys (and `RUSDC_MINT`, `RUSDC_AUDITOR_IKM`) while leaving `BACKEND_MODE=mock`
  gets you real on-chain sponsorship and minting with mock auth and mock KYC — this is the practical
  "as live as it gets today" configuration for a hosted demo, and what `docs/deploy.md`'s smoke test
  assumes.
- KYC is mock: the verification page this backend serves decides instantly, with no real Sumsub
  check. Say so on stage if asked.
