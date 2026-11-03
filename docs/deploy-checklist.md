# Hosted demo: one ordered runbook

Everything the user runs by hand, in order, to get `relstate.casa` (app, GitHub Pages) and the
Fly.io backend live against Solana devnet. This agent cannot run any of it — no `flyctl`, no DNS,
no GitHub settings, no Solana upgrade authority. Each step says **who signs/runs it**. Full
narrative detail lives in [`deploy.md`](deploy.md), [`env-checklist.md`](env-checklist.md) and the
`devnet-program-deploy` artifact; this page is the condensed order of operations with exact
commands and variable **names** (never values/secrets).

**Current state note (read this first):** this branch (`deploy-prep`, off `demo`) still has the
*old* appraiser model: a backend-held registry (`APPRAISERS`, `APPRAISER_KEYPAIRS`,
`VERDICT_CONSOLE_TOKEN`, `VERDICT_CONSOLE_LEASES`) and an operator console gated by
`VITE_APPRAISER_CONSOLE=1`. Branches `open-appraisers` (program), `oa-backend`, `oa-app` replace
all of that with party-chosen appraisers invited by e-mail (`INVITE_EMAIL_SENDER`,
`INVITE_TTL_SECONDS`, route `#/invite/<token>`) and are being merged into `demo` separately. This
checklist is written for **that final, merged state** — the registry/console variables above do
**not** appear below. See "If you deploy before the open-appraiser merge lands" at the end for the
one-line adjustment needed to run the current branch instead.

## 0. Accounts you need before starting

Fly account + CLI (`fly auth login`), GitHub repo with Pages enabled (Settings → Pages → Source:
**GitHub Actions**), a domain you control DNS for, a [Helius](https://helius.dev) devnet API key,
a [Stripe](https://dashboard.stripe.com) account in **test mode**. The Rust/Anchor/Solana
toolchain locally, and the devnet program's upgrade-authority keypair
(`~/.config/relstate/program-keypair.json`, program id `G4iMjveQKXztnGoxigAeWPrb5evT9yt6qaLkgQEp2dXm`).

## 1. Program: build, verify, upgrade on devnet (you run this)

```bash
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/bin:$PATH"
git log --oneline -1 && git status --short      # expect the merged open-appraisers state, clean
make program-keypair
anchor build -- --features demo 2>&1 | tee /tmp/anchor-build.log
grep -c "overwrites values in the frame" /tmp/anchor-build.log   # MUST print 0
```

If that grep prints anything > 0, **stop** — do not deploy; the memory-layout warning means an
upgrade over live leases would corrupt accounts. Fix the layout first.

```bash
ls -l target/deploy/relstate.so            # ~567 KB first deploy, ~720 KB D2/open-appraiser build
bash scripts/sync-idl.sh                   # must print CLAIM_WINDOW_SECS=3, DISPUTE_WINDOW_SECS=45
git status --short                         # app/idl/* must show no diff; if it does, commit it
```

**First deploy ever** (program id has never existed on devnet):

```bash
solana balance -u devnet -k ~/.config/solana/id.json   # need >= 4 SOL
solana program deploy target/deploy/relstate.so \
  --program-id ~/.config/relstate/program-keypair.json \
  --keypair ~/.config/solana/id.json --max-len 700000 -u devnet
solana program show G4iMjveQKXztnGoxigAeWPrb5evT9yt6qaLkgQEp2dXm -u devnet   # check Authority, Data Length
```

**Upgrading an existing devnet deploy to the open-appraiser build** (binary is larger than the
700,000 bytes reserved — extend first, costs ~0.7 SOL from the upgrade authority):

```bash
solana program extend G4iMjveQKXztnGoxigAeWPrb5evT9yt6qaLkgQEp2dXm 100000 -u devnet
solana program deploy target/deploy/relstate.so \
  --program-id ~/.config/relstate/program-keypair.json \
  --keypair ~/.config/solana/id.json -u devnet
```

One-way: once any lease has advanced dispute state under the new program, do not roll back. Only
upgrade after the program's independent security review is clean.

## 2. Devnet setup equivalent to `make demo-setup` (you run this)

Decide the Config admin key first (recommendation: the backend **treasury** key, so the same key
that mints rUSDC can also run `set_mint_allowed`; it is *not* the program's upgrade authority — see
step 1). Either reuse an existing treasury keypair or generate one:

```bash
solana-keygen new --no-bip39-passphrase -o ~/.config/relstate/treasury.json
```

Create Config + the test-USDC mint + default listings (idempotent, safe to re-run):

```bash
RPC=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/relstate/treasury.json \
  make demo-setup WALLETS="<landlord wallet> <tenant wallet>"
```

`ANCHOR_WALLET` must be a keypair **file path**, not an address — passing an address fails
`ENOENT`. `NotAdmin` later means a different keypair ran `init_config`; redo with the right one.

Create rUSDC (writes `RUSDC_MINT`, `RUSDC_AUDITOR_IKM`, `RUSDC_AUDITOR_ELGAMAL_PUBKEY` to the
repo-root git-ignored `.env` — record all three, they feed Fly secrets/env and the Pages build):

```bash
RPC_URL=https://api.devnet.solana.com TREASURY_KEYPAIR=~/.config/relstate/treasury.json \
  node scripts/make-rusdc.ts
ADMIN_KEYPAIR=~/.config/relstate/treasury.json RPC=https://api.devnet.solana.com \
  node scripts/allow-mint.ts <RUSDC_MINT from above>
```

## 3. `require_kyc` decision (you run this, once)

Pick one; both are honest demo states. The app's "Verified" badge works either way — this only
gates `apply` / `propose_lease` on chain.

- **Leave it off** (simplest; recommended unless the pitch specifically needs the gate).
- **Turn it on:**
  ```bash
  solana-keygen new --no-bip39-passphrase -o ~/.config/relstate/issuer.json   # if you don't have one
  ADMIN_KEYPAIR=~/.config/relstate/treasury.json \
    ATTESTATION_ISSUER=$(solana-keygen pubkey ~/.config/relstate/issuer.json) \
    RPC=https://api.devnet.solana.com node scripts/setup-kyc.ts on
  ```
  The gate script used for any later smoke test needs `require_kyc` **off**, unless it attests the
  tenant first.

## 4. Fly: create the app, set every secret (you run this)

```bash
fly launch --no-deploy   # picks up fly.toml; decline Postgres/Redis, this backend needs neither
```

Check the merged `fly.toml` still has `min_machines_running = 1`, `auto_stop_machines = false`,
`dockerfile = "backend/Dockerfile"` — `fly launch` sometimes rewrites these. **Do not raise
`min_machines_running` above 1** (see `fly.toml`'s header comment: rate limits, the replay guard
and session lookups are all per-process in memory; a second machine silently doubles every cap).

No Fly volume is needed — the backend is stateless (every secret listed below is injected as an
env var; nothing persists to disk).

Set every secret below in **one** `fly secrets set` call (fill in your own values — never paste
real values into chat, a PR, or a committed file):

```bash
fly secrets set \
  SESSION_SECRET="$(openssl rand -base64 32)" \
  ADMIN_TOKEN="$(openssl rand -base64 32)" \
  KYC_SUBJECT_SALT="$(openssl rand -base64 32)" \
  HELIUS_API_KEY='<...>' \
  FEE_PAYER_KEYPAIR='<...>' \
  ATTESTATION_ISSUER_KEYPAIR='<...>' \
  TREASURY_KEYPAIR='<...>' \
  RUSDC_AUDITOR_IKM='<...>' \
  STRIPE_SECRET_KEY='<...>' \
  STRIPE_WEBHOOK_SECRET='<...>'   # from step 6 below; set a placeholder now, update after
```

Fly secrets only accept inline values — for the three keypairs, pass the keypair file's JSON-array
contents (`cat <file>`) or a base58 secret, per `backend/src/keys.ts`.

**Every variable the backend actually reads**, from `backend/src/env.ts` (★ = required once
`BACKEND_MODE=live`; current `fly.toml` ships `mock`, see note below):

| Variable | Kind | Required |
|---|---|---|
| `SOLANA_CLUSTER` | Fly env | optional (default `devnet`) |
| `HELIUS_API_KEY` | secret | strongly recommended |
| `RPC_URL` | Fly env | only if `HELIUS_API_KEY` unset |
| `RPC_MAX_RETRIES` / `RPC_RETRY_BASE_MS` / `RPC_RETRY_MAX_MS` | Fly env | optional |
| `PORT` | Fly env | optional (baked to `8787`) |
| `BACKEND_MODE` | Fly env | `mock` or `live` |
| `AUTH_MODE` | Fly env | optional (★ refuses `mock`; use `wallet`) |
| `WALLET_SESSION_TTL_SECONDS` / `AUTH_CHALLENGE_TTL_SECONDS` / `AUTH_RATE_PER_MINUTE` / `TREASURY_RATE_PER_MINUTE` | Fly env | optional |
| `SESSION_SECRET` | secret | ★ |
| `SESSION_TTL_SECONDS` | Fly env | optional |
| `ADMIN_TOKEN` | secret | ★ (guards `/api/treasury/wrap`, `/credit-reserve`) |
| `CORS_ORIGIN` | Fly env | ★ (never `*` once live) |
| `RELSTATE_IDL` | Fly env | set by the image, do not set |
| `APP_URL` | Fly env | ★ when `AUTH_MODE=wallet` |
| `FEE_PAYER_KEYPAIR` | secret | ★ |
| `ATTESTATION_ISSUER_KEYPAIR` | secret | ★ |
| `TREASURY_KEYPAIR` | secret | ★ |
| `KYC_SUBJECT_SALT` | secret | ★ |
| `RUSDC_MINT` | Fly env | ★ |
| `RUSDC_DECIMALS` | Fly env | optional (default 6) |
| `RUSDC_AUDITOR_IKM` | secret | ★ |
| `RUSDC_AUDITOR_ELGAMAL_PUBKEY` | Fly env | optional, reference only |
| `USDC_RESERVE_MINT` / `USDC_RESERVE_TOKEN_ACCOUNT` | Fly env | optional |
| `INVITE_EMAIL_SENDER` | Fly env | optional (`console` \| `none`; blank = `console` in mock, `none` in live) — **post open-appraiser merge only** |
| `INVITE_TTL_SECONDS` | Fly env | optional (blank follows the program's `SELECTION_WINDOW_SECS`) — **post open-appraiser merge only** |
| `SPONSOR_MAX_*` (8 vars), `RENT_PAYMENT_MAX_*` (8 vars), `RENT_DUST_MAX_*` (2 vars) | Fly env | optional, tune only. Set `SPONSOR_MAX_CU_PRICE_MICROLAMPORTS=400000` for devnet priority-fee headroom |
| `KYC_PROVIDER` | Fly env | optional (default `mock`) |
| `ALLOW_MOCK_KYC` | Fly env | set to exactly `devnet` to run mock KYC under `BACKEND_MODE=live` (also needs `SOLANA_CLUSTER=devnet`) |
| `KYC_LEVEL` / `KYC_VALIDITY_DAYS` | Fly env | optional |
| `KYC_MOCK_MAX_ATTESTS_PER_HOUR` / `KYC_MOCK_MAX_LAMPORTS_PER_DAY` / `KYC_MOCK_LAMPORTS_PER_ATTEST` | Fly env | optional |
| `TRUST_PROXY_IP_HEADER` | Fly env | not needed on Fly (auto-detected via `FLY_APP_NAME`) |
| `SUMSUB_*` (7 vars) | secret/env | only if `KYC_PROVIDER=sumsub` (not used by this demo) |
| `ONRAMP_PROVIDER` | Fly env | optional (set `stripe` once the two Stripe secrets are set) |
| `OFFRAMP_PROVIDER` | Fly env | always `mock` |
| `STRIPE_SECRET_KEY` | secret | ★ when `ONRAMP_PROVIDER=stripe` |
| `STRIPE_WEBHOOK_SECRET` | secret | ★ when `ONRAMP_PROVIDER=stripe` (dashboard endpoint secret, not `stripe listen`'s) |
| `STRIPE_API_BASE` / `STRIPE_WEBHOOK_TOLERANCE_SECONDS` | Fly env | optional |
| `DEMO_PLN_PER_USDC` / `ONRAMP_MIN_PLN` / `ONRAMP_MAX_PLN` / `ONRAMP_MAX_USDC_PER_WALLET_PER_DAY` / `OFFRAMP_MAX_USDC_PER_WALLET_PER_DAY` | Fly env | optional |

Not in this table because the merge removes them: `APPRAISERS`, `APPRAISER_KEYPAIRS`,
`VERDICT_CONSOLE_TOKEN`, `VERDICT_CONSOLE_LEASES` — see the end-of-page note if you must deploy
before the merge lands.

Set the non-secret, domain-specific values by editing `fly.toml`'s `[env]` block (simpler, none are
secret) or with `fly secrets set`:

```toml
# fly.toml [env]
CORS_ORIGIN = "https://relstate.casa"
APP_URL = "https://relstate.casa/app/"
RUSDC_MINT = "<mint from step 2>"
SPONSOR_MAX_CU_PRICE_MICROLAMPORTS = "400000"
```

`fly.toml` currently ships `BACKEND_MODE=mock`, `AUTH_MODE=mock` — with the keys above set, mock
mode still does real on-chain sponsorship and rUSDC minting; only login and the KYC decision stay
mocked. Flip to `live`/`wallet` only once every ★ variable above is set. Then:

```bash
fly deploy
```

## 5. GitHub Pages: repository Variables + `deploy` branch (you run this)

Settings → Secrets and variables → Actions → **Variables** tab (not Secrets — every `VITE_*` value
is compiled into the public JS bundle, so hiding it protects nothing). `.github/workflows/pages.yml`
fails fast with a named list if one is missing — only the five below are hard-checked:

| Variable | Required | Value |
|---|---|---|
| `VITE_API` | ★ checked | `https://<your-fly-app>.fly.dev` |
| `VITE_RUSDC_MINT` | ★ checked | the mint from step 2 |
| `VITE_MINT` | ★ checked | for the confidential demo, must **equal** `VITE_RUSDC_MINT` |
| `SITE_APP_URL` | ★ checked | `https://relstate.casa/app/` (trailing `/app/`) |
| `CUSTOM_DOMAIN` | ★ checked | `relstate.casa` — written verbatim into the Pages artifact's `CNAME` |
| `VITE_CLUSTER` | not hard-checked, but **set it** | `devnet` — without it the wallet names no cluster and the extension may warn "transaction reverted during simulation" on transactions that actually succeed |
| `VITE_FEE_PAYER` | optional | leave blank; app asks `GET /api/sponsor` |
| `VITE_RPC` | **leave unset** | setting it ships an RPC URL (and any key in it) to every visitor; the app reads through `${VITE_API}/api/rpc` instead |

`VITE_EMBEDDED_WALLET` is fixed to `mock` by the workflow itself (not a repo variable) — Privy's
SDK binding isn't wired up, so there is no real Privy app id or dashboard allowed-origins step to
do for this deploy. `VITE_APPRAISER_CONSOLE` does not exist post-merge (replaced by the invite
flow, which needs no build flag) — do not set it.

```bash
git branch deploy <branch holding the final demo build>
git push origin deploy
```

Watch the Actions tab for `pages.yml`.

## 6. DNS for `relstate.casa` (you run this, in your registrar)

- Apex `relstate.casa`: four `A` records → `185.199.108.153`, `185.199.109.153`,
  `185.199.110.153`, `185.199.111.153`; optionally `AAAA` → `2606:50c0:8000::153`,
  `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`.
- `api.relstate.casa`: **not used directly by GitHub Pages** — the backend is reached at its
  `<app>.fly.dev` hostname (set as `VITE_API` above), not a custom subdomain, unless you also add a
  Fly custom-domain certificate for `api.relstate.casa` (`fly certs add api.relstate.casa` + a
  `CNAME api.relstate.casa → <app>.fly.dev`). Only do this if you want the API on your own domain;
  it is not required for the checklist above to work.
- Repo Settings → Pages → Custom domain → `relstate.casa` → save (this also sets the expected
  `CNAME` file value `pages.yml` writes from `CUSTOM_DOMAIN`). Check **Enforce HTTPS** once issued.
- Propagation: minutes to ~48 hours — do this well before the demo.

## 7. Stripe webhook, test mode (you run this)

1. Stripe dashboard, **test mode** toggle on → Developers → Webhooks → Add endpoint.
2. URL: `https://<your-fly-app>.fly.dev/api/webhooks/stripe`.
3. Event: `checkout.session.completed`.
4. Copy the **Signing secret** (`whsec_...`).
5. `fly secrets set STRIPE_WEBHOOK_SECRET='whsec_...'` (redeploys the machine — expected).

The Stripe CLI's `stripe listen` secret is for `localhost` only; it will not verify against a
hosted backend.

## 8. CORS / wallet checks (you verify after deploy)

- `CORS_ORIGIN` on Fly must equal the app's exact origin (`https://relstate.casa`), not `*`, once
  `BACKEND_MODE=live`. Mock mode does not enforce this but should still be set correctly so a later
  flip to live doesn't surface a fresh bug.
- Open the site and the app in a real browser with Phantom (or another Wallet Standard extension)
  installed; confirm no CORS error in the network tab when the app calls `${VITE_API}/api/...`, and
  that a signing prompt names **devnet** (this is what `VITE_CLUSTER` fixes — see step 5).

## 9. Health checks and smoke test (you run these, after both deploys are up)

```bash
curl https://<your-fly-app>.fly.dev/health
# expect: "ok": true, "mode", and feePayer/attestationIssuer/treasury addresses you recognize
# (NOT in "ephemeralKeys" — that means a key secret didn't take)
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<your-fly-app>.fly.dev/api/rpc \
  -H "Content-Type: application/json" -d '{"method":"getHealth","params":[]}'
```

Then, by hand:

- [ ] `https://relstate.casa/` loads; theme toggle works; devnet disclaimer in the footer.
- [ ] `https://relstate.casa/app/` loads **directly** (not just by click-through) — confirms the
      `/app/` subpath and hash routing work with no server rewrites.
- [ ] Network tab: `/api/...` calls go to the Fly app, no CORS block.
- [ ] Sign up with a fresh email → `POST /api/auth/mock` succeeds, lands on a wallet.
- [ ] Stripe test card `4242 4242 4242 4242` → redirected to
      `#/app?tab=wallet&topup=done&...` → balance updates.
- [ ] Stripe dashboard → Webhooks → endpoint → Event log shows **200**, not a retry.
- [ ] Propose a lease, fund the deposit, pay rent once (exercises the treasury-cosigned routes).
- [ ] (post-merge) Open an appraiser invite link `#/invite/<token>` in a private window, confirm it
      loads the Appraise screen and is not gated behind any removed console flag.

## 10. Teardown, right after the demo (you run this)

```bash
fly apps destroy <your-app-name>
```

Remove the DNS records from step 6; set Pages Source back to "None" or delete the `deploy` branch;
revoke the Helius key and delete the Stripe test-mode webhook endpoint; leave the devnet program
deployed (costs nothing ongoing) or close it with `solana program close <id> -u devnet
--bypass-warning` if you want the rent back (irreversible — the id can never be redeployed).

## If you deploy before the open-appraiser merge lands

Everything above still applies **except**: add `APPRAISERS`, `APPRAISER_KEYPAIRS`,
`VERDICT_CONSOLE_TOKEN` (and ideally `VERDICT_CONSOLE_LEASES`) as Fly secrets/env instead of
`INVITE_EMAIL_SENDER`/`INVITE_TTL_SECONDS` (see the current `docs/env-checklist.md` on this branch
for their exact formats), run `scripts/setup-appraisers.ts` once after step 2, and set
`VITE_APPRAISER_CONSOLE=1` as a GitHub Pages repository variable (not hard-checked by `pages.yml`,
but required for the operator console screen to build in). Re-run this whole checklist's variable
table against `backend/src/env.ts` once the merge lands — the table above was generated by reading
`env.ts` on `oa-backend`, not by running the merged code.

## What this agent verified without credentials

- Backend boots in `BACKEND_MODE=mock` on a scratch port (18787, not 8787/8899) and `/health`
  returns `ok: true` with no missing-config crash.
- `npm run app:build` with hosted-style env (`VITE_API`, `VITE_RUSDC_MINT`, `VITE_MINT`,
  `VITE_CLUSTER=devnet`, `VITE_EMBEDDED_WALLET=mock`) succeeds; the built `index.html` references
  `/app/assets/...`, confirming the `BASE=/app/` path `pages.yml` sets is correct for the Pages
  artifact layout in `docs/deploy.md`/`pages.yml`.
- **Fixed a real bug:** `pages.yml`'s "Build app" step read `VITE_API`, `VITE_RUSDC_MINT`,
  `VITE_MINT`, `VITE_FEE_PAYER` from repository Variables but never passed `VITE_CLUSTER` through,
  even though `docs/env-checklist.md` and `docs/wallet-simulation.md` both say a proxied deploy
  **must** set it. Setting the repo variable alone would have had no effect — the build step now
  forwards it.
- Docker is installed on this machine but its daemon was not running, so the backend image build
  (`docker build -f backend/Dockerfile`) could not be verified end to end; the Dockerfile was only
  read, not built. Recommend the user run that build once locally before `fly deploy` if they want
  extra confidence, since `fly deploy` performs an equivalent build remotely regardless.
