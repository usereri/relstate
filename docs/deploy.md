# Deploy runbook: demo-day hosting

Deploys Relstate for a **few days**, as cheaply and reliably as that allows: the static front end
(site + app) on GitHub Pages under a custom domain, the backend on Fly.io, the program on Solana
devnet. Written for someone doing this once, by hand, in order. Read
[`docs/env-checklist.md`](env-checklist.md) alongside this — it has every variable this page tells
you to set, with its exact name and format.

**Live mode:** a hosted backend can run `BACKEND_MODE=live` with `AUTH_MODE=wallet` (wallet-signature
login; set `APP_URL`) and, on devnet only, `KYC_PROVIDER=mock` with `ALLOW_MOCK_KYC=devnet` — see
[env-checklist.md](env-checklist.md). `BACKEND_MODE=mock` with `AUTH_MODE=mock` still works for a
no-keys demo, but **never share `SESSION_SECRET` between a mock and a live deployment**. The step
that follows (3.4) and `fly.toml` currently ship `BACKEND_MODE=mock`; switch them to live only after
the live variables in the checklist are set.

**Budgets reset on restart.** The mock-KYC attestation budget (default 30/hour, 100/day) and the login and sponsor rate limits are in memory, so a machine restart or redeploy resets them. Run a single Fly machine and treat the daily cap as per-process.

## 0. Prerequisites and accounts

| What | Why | Get it |
|---|---|---|
| A GitHub repo with Pages enabled | hosts the static site + app | Settings → Pages → Source: **GitHub Actions** (not "Deploy from a branch") |
| A custom domain you control DNS for | the demo's public URL | any registrar; this runbook assumes you already own one |
| [Fly CLI](https://fly.io/docs/flyctl/install/) + a Fly account | hosts the backend | `fly auth login` after installing |
| A [Helius](https://helius.dev) account, free tier is fine | devnet RPC that doesn't 429 under the confidential-transfer proof plan (Phase 0 result) | sign up, create a devnet API key |
| A [Stripe](https://dashboard.stripe.com) account, **test mode** | the on-ramp checkout page | sign up; stay in test mode the whole time, never flip to live keys |
| The Rust/Anchor/Solana toolchain, locally | **you** deploy the program (see step 1) — this agent does not | `rustup`, `solana-cli`, `anchor-cli` 1.1, per `README.md` |

Also decide your Fly app name (globally unique) and region (`waw` Warsaw or `fra` Frankfurt are
closest to Poland) — both are already filled in in `fly.toml`, change them if you want different
ones.

## 1. Deploy the program to devnet

This is **your** manual step — nothing here does it for you. Full instructions, including the
"fresh network state required" warning (accounts grew, no migration, an in-place upgrade over old
leases strands them) are in `README.md` → **Devnet**, step 1. Repeating only the one command that
matters because it's easy to get wrong:

```bash
anchor build -- --features demo         # the demo build is MANDATORY — the client reads
anchor deploy --provider.cluster devnet #   CLAIM_WINDOW_SECS / DISPUTE_WINDOW_SECS from the IDL
```

Then run `scripts/sync-idl.sh` (repo root) to refresh the tracked copy the app and the backend
container build from:

```bash
scripts/sync-idl.sh   # refuses to sync a release-build IDL (wrong CLAIM/DISPUTE window)
```

Commit the result (`app/idl/relstate.json`, `app/idl/relstate.ts`) — CI and the Fly image both read
this tracked copy, not your local `target/`.

## 2. DNS for the custom domain

In your registrar's DNS panel, point the domain at GitHub Pages:

- **Apex domain** (`relstate.example`): four `A` records to GitHub's Pages IPs —
  `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` — and, optionally,
  `AAAA` records to `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`,
  `2606:50c0:8003::153`.
- **Subdomain** (`demo.relstate.example`): a single `CNAME` to `<your-github-username>.github.io`.

Then, in the repo: Settings → Pages → Custom domain → enter the domain → save (this is also what
creates the `CNAME` file's expected value — `pages.yml` writes the same file from the
`CUSTOM_DOMAIN` repository variable on every build, so set that variable to the exact same string).
Check **Enforce HTTPS** once the certificate is issued. **DNS propagation can take anywhere from
minutes to ~48 hours** — do this well before the demo, not the morning of.

## 3. Order of operations

### 3.1 `make demo-setup` against devnet

```bash
RPC=https://api.devnet.solana.com make demo-setup WALLETS="<landlord wallet> <tenant wallet>"
```

This funds the two wallets you'll use to rehearse, seeds four listings, and — the part that
matters for later — runs `init_config` (whoever's `ANCHOR_WALLET`/`~/.config/solana/id.json` this
is becomes the Config admin) and `set_mint_allowed` for the test-USDC mint
(`docs/contracts/program-interface.md` §2 and §4).

**If you plan to flip the backend to real on-chain sponsorship** (step 3.4), run this step with
`ANCHOR_WALLET` pointed at a keypair you will also use as the backend's `TREASURY_KEYPAIR` — the
program interface doc recommends the treasury key end up as Config admin
(`docs/contracts/program-interface.md` §4), and doing it in this order avoids a `set_admin` hand-off
step later. Generate that keypair first if you don't have one yet:

```bash
solana-keygen new --no-bip39-passphrase -o ~/.config/relstate/treasury.json
RPC=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/relstate/treasury.json \
  make demo-setup WALLETS="<landlord wallet> <tenant wallet>"
```

### 3.2 (optional) turn on the KYC gate

Only if you want `require_kyc` enforced on chain for the demo (the app's "Verified" badge works
either way; this only gates `apply`/`propose_lease`):

```bash
ADMIN_KEYPAIR=~/.config/relstate/treasury.json ATTESTATION_ISSUER=<issuer pubkey> \
  RPC=https://api.devnet.solana.com node scripts/setup-kyc.ts on
```

`ATTESTATION_ISSUER` is the **public** key of whatever you set `ATTESTATION_ISSUER_KEYPAIR` to in
step 4 below — generate that keypair now if you haven't:
`solana-keygen new --no-bip39-passphrase -o ~/.config/relstate/issuer.json`, then pass its pubkey
(`solana-keygen pubkey ~/.config/relstate/issuer.json`) here.

### 3.3 Create rUSDC

```bash
RPC_URL=https://api.devnet.solana.com TREASURY_KEYPAIR=~/.config/relstate/treasury.json \
  node scripts/make-rusdc.ts
```

Writes `RUSDC_MINT`, `RUSDC_AUDITOR_IKM` and `RUSDC_AUDITOR_ELGAMAL_PUBKEY` into the repo-root
`.env` (git-ignored) and prints them. **Record all three** — they go into Fly secrets/env in step 4,
and `RUSDC_MINT` also goes into the Pages build variables (`docs/env-checklist.md`).

Then allow rUSDC on the Config allowlist, signed by the same treasury key, with
`scripts/allow-mint.ts` — the same `set_mint_allowed` instruction `scripts/setup-demo.ts` already
uses for test-USDC, documented in `docs/contracts/program-interface.md` §2:

```bash
ADMIN_KEYPAIR=~/.config/relstate/treasury.json RPC=https://api.devnet.solana.com \
  node scripts/allow-mint.ts <RUSDC_MINT from step 3.3>
```

It prints the Config PDA, the admin's public key and the mint before sending anything, and never
prints a secret. Pass `off` as a second argument later if you ever need to remove a mint from the
allowlist (e.g. `node scripts/allow-mint.ts <mint> off`) — it's idempotent either way, so running it
again (on or off) when nothing needs to change is harmless. `ADMIN_KEYPAIR` is never defaulted to
`~/.config/solana/id.json`; this fails with `NotAdmin` if the keypair you pass is not the one that
holds Config admin — see 3.1's note.

### 3.4 Stand up the backend on Fly

```bash
fly launch --no-deploy   # picks up fly.toml; say no to a new Postgres/Redis, this backend needs neither
```

Check the generated/merged `fly.toml` still has `min_machines_running = 1`, `auto_stop_machines =
false` and `dockerfile = "backend/Dockerfile"` — `fly launch` sometimes rewrites fields.

Set every secret from `docs/env-checklist.md`'s "Keys" section (this is one command; fill in your
own values — **never paste these into chat, a PR, or a committed file**):

```bash
fly secrets set \
  FEE_PAYER_KEYPAIR='<inline 64-byte JSON array or base58 secret>' \
  ATTESTATION_ISSUER_KEYPAIR='<...>' \
  TREASURY_KEYPAIR='<...>' \
  RUSDC_AUDITOR_IKM='<base64 seed from scripts/make-rusdc.ts>' \
  SESSION_SECRET="$(openssl rand -base64 32)" \
  ADMIN_TOKEN="$(openssl rand -base64 32)" \
  KYC_SUBJECT_SALT="$(openssl rand -base64 32)" \
  HELIUS_API_KEY='<your Helius devnet key>' \
  STRIPE_SECRET_KEY='sk_test_...' \
  STRIPE_WEBHOOK_SECRET='whsec_...'      # from step 5 below — set it AFTER creating the endpoint,
                                          # or set a placeholder now and `fly secrets set` it again later
```

Fly secrets only accept inline values, not file paths, so the fee payer / treasury / issuer keys go
in as the **contents** of the keypair file (a JSON array like `[12,34,...]`) or as base58, exactly as
`backend/src/keys.ts` accepts (`cat ~/.config/relstate/treasury.json` to get the JSON-array form).

Set the non-secret values (domain-specific, so not pre-filled in `fly.toml`) either by editing
`fly.toml`'s `[env]` block or with `fly secrets set` (either works; `[env]` is simpler since none of
these are secret):

```toml
# fly.toml [env]
CORS_ORIGIN = "https://relstate.example"
APP_URL = "https://relstate.example/app/"
RUSDC_MINT = "<mint from step 3.3>"
```

Then deploy:

```bash
fly deploy
```

`fly.toml` keeps `BACKEND_MODE=mock` — see the headline limit at the top of this page. With the
three keys above set, mock mode still does **real** on-chain sponsorship and rUSDC minting; it's the
login and KYC decision that stay mocked.

### 3.5 GitHub repository variables + the `deploy` branch

Settings → Secrets and variables → Actions → **Variables** tab (not Secrets — see
`docs/env-checklist.md` for why), set every variable in that page's "App" and "Site" tables:
`VITE_API` (your Fly app's `https://<app>.fly.dev` URL), `VITE_RPC` (a **domain-restricted** Helius
key — restrict it to your Pages domain in the Helius dashboard, since this one ships in the public
bundle), `VITE_RUSDC_MINT`, `VITE_MINT`, `SITE_APP_URL`, `CUSTOM_DOMAIN`.

Then push (or fast-forward) a `deploy` branch to trigger `pages.yml`:

```bash
git branch deploy p4-deploy     # or whichever branch currently holds the demo build
git push origin deploy
```

Watch the Actions tab; `pages.yml` fails fast with a named list of missing variables if you missed
one.

## 4. Stripe webhook (test mode)

The **Stripe CLI's** webhook secret (`stripe listen`) is for `localhost` only — it does not work for
a hosted backend. For Fly:

1. Stripe dashboard (stay in **test mode**, top-left toggle) → Developers → Webhooks → **Add
   endpoint**.
2. Endpoint URL: `https://<your-fly-app>.fly.dev/api/webhooks/stripe`.
3. Events to send: `checkout.session.completed`.
4. Create it, then open it and copy the **Signing secret** (`whsec_...`).
5. `fly secrets set STRIPE_WEBHOOK_SECRET='whsec_...'` (this redeploys the machine with the new
   secret — expected, it's the only way Fly secrets take effect).

## 5. Smoke test checklist

Run through this once the Pages deploy and the Fly deploy are both up, **before** the demo:

- [ ] `curl https://<your-fly-app>.fly.dev/health` → `"ok": true`, `"mode": "mock"`, and
      `feePayer`/`attestationIssuer`/`treasury` are the addresses you expect (not `ephemeralKeys`
      including ones you meant to configure — an ephemeral key there means a secret didn't take).
- [ ] Open `https://<your domain>/` — the site loads, dark/light theme toggle works, footer shows
      the devnet disclaimer.
- [ ] Open `https://<your domain>/app/` directly (not just by clicking through from the site) —
      confirms the Pages artifact's `/app/` subpath and hash routing both work with no rewrites.
- [ ] From the browser's network tab, confirm requests to `/api/...` go to your Fly app and are not
      blocked by CORS (a misconfigured `CORS_ORIGIN` shows up here first).
- [ ] Sign up with a fresh email → the app reaches `POST /api/auth/mock` and lands on a wallet.
- [ ] Top up with the Stripe test card `4242 4242 4242 4242` (any future expiry, any CVC) → redirected
      back to `#/app?tab=wallet&topup=done&...` → balance updates.
- [ ] Stripe dashboard → Developers → Webhooks → your endpoint → **Event log**: the
      `checkout.session.completed` delivery shows **200**, not a retry.
- [ ] Propose a lease, fund the deposit, pay rent once — confirms the treasury-cosigned routes
      (`/api/treasury/rent-dust`, `/api/treasury/rent-payment`) work against the live program.

## 6. Cost and teardown

**Rough running cost** (check current pricing before relying on this — both are usage-based, not
flat):

| | |
|---|---|
| GitHub Pages | free for a public repo |
| Fly.io, one `shared-cpu-1x` / 512 MB machine, always on | a few dollars a month at Fly's current usage pricing; stopping it the moment the demo ends is what keeps this small |
| Helius devnet key | free tier is normally enough for a few days of demo traffic |
| Stripe test mode | free — no real money moves |
| Custom domain | whatever your registrar charges annually; unrelated to this demo's hosting cost |

**Teardown, right after the demo:**

```bash
fly apps destroy <your-app-name>      # stops billing for the backend immediately
```

- Remove the DNS records from step 2 (or just the `A`/`AAAA`/`CNAME` for the demo subdomain, if the
  apex is used for something else).
- Repo Settings → Pages → set Source back to "None", or delete the `deploy` branch — either stops
  future pushes from republishing.
- Revoke/delete the Helius API key and the Stripe test-mode webhook endpoint (Stripe test mode costs
  nothing left running, but a stale endpoint pointing at a destroyed Fly app just logs failed
  deliveries forever — delete it).
- The devnet program deployment itself costs nothing ongoing (devnet SOL isn't real money); leave it
  or redeploy over it next time, your call.

## 7. Hetzner alternative

The backend image is deliberately generic — the same one Fly runs, runs anywhere Docker does:

```bash
docker build -f backend/Dockerfile -t relstate-backend .
docker run -d --name relstate-backend \
  --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -e BACKEND_MODE=mock -e AUTH_MODE=mock \
  -e CORS_ORIGIN=https://relstate.example -e APP_URL=https://relstate.example/app/ \
  -e HELIUS_API_KEY=... -e FEE_PAYER_KEYPAIR=... -e ATTESTATION_ISSUER_KEYPAIR=... \
  -e TREASURY_KEYPAIR=... -e RUSDC_MINT=... -e RUSDC_AUDITOR_IKM=... \
  -e SESSION_SECRET=... -e ADMIN_TOKEN=... -e STRIPE_SECRET_KEY=... -e STRIPE_WEBHOOK_SECRET=... \
  relstate-backend
```

Put it behind [Caddy](https://caddyserver.com/) for automatic HTTPS — a two-line Caddyfile:

```
relstate.example {
  reverse_proxy 127.0.0.1:8787
}
```

`caddy run` (or the Caddy systemd service) gets you a Let's Encrypt certificate with no further
config. Everything else in this runbook (Pages, DNS, Stripe, the smoke test) is unchanged; only
"where the backend lives" differs.

## 8. Rollback and "the demo network is down"

| Symptom | What to do |
|---|---|
| Devnet RPC 429s on stage | Switch `HELIUS_API_KEY` to a fresh key (dashboards sometimes rate-limit a key, not just the account), or increase `RPC_MAX_RETRIES`/`RPC_RETRY_MAX_MS` and redeploy. The app and backend already retry with backoff (Phase 0 result) — a 429 should self-heal in a few seconds, not hang. |
| Backend cold start / unresponsive | `min_machines_running = 1` + `auto_stop_machines = false` means it shouldn't sleep; if it's down, `fly status`, `fly logs`, then `fly machine restart <id>`. A crash loop usually means a missing/bad secret — `fly logs` prints `assertEnvConsistent`'s message naming exactly which one. |
| Stripe webhook retries / shows pending | Stripe retries a failing webhook for up to 3 days; check the event log for the actual error first (signature mismatch is almost always a stale `STRIPE_WEBHOOK_SECRET` from before you rotated it in step 4). You can also manually resend an event from the dashboard. |
| A bad Fly deploy broke the backend | `fly releases list` then `fly deploy --image <previous image digest>` — Fly keeps every build's image, so this is a straight rollback with no rebuild needed. |
| A bad Pages deploy broke the front end | `git revert` the bad commit on the `deploy` branch and push — `pages.yml` rebuilds and republishes the reverted state. There is no "previous artifact" redeploy button; a revert + push is the rollback. |
| Everything is on fire, five minutes to stage | Fall back to the Phase 1 scripted devnet run recording (`docs/demo-day-plan` cut line) and narrate live from there. |
