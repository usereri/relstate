# Contract 3: `Attestation` account (workstream D, implemented)

A wallet's KYC result, written on chain by a key that does nothing else. The program reads it in
`apply` and `propose_lease` when the gate is on. No personal data is stored anywhere we control.

## Account layout

Seeds `[b"attestation", wallet]`. 8-byte discriminator + 115 bytes = 123 bytes (`INIT_SPACE` 115).

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 8 | `wallet` | Pubkey | the attested wallet (also in the seeds) |
| 40 | `issuer` | Pubkey | the issuer at signing time; compared with `Config::issuer` on every check |
| 72 | `level` | u8 | 1 basic, 2 enhanced. 0 is never stored: `attest` refuses it |
| 73 | `verified_at` | i64 | chain clock when written |
| 81 | `expires_at` | i64 | unix seconds; 0 = never. The demo issues one year |
| 89 | `revoked` | bool | set by `revoke`, cleared by a later `attest` |
| 90 | `subject_hash` | [u8; 32] | `sha256(applicantId \|\| salt)`, salt secret and server-side only |
| 122 | `bump` | u8 | |

`Config` gained two fields **after** `mints`: `issuer: Pubkey` (all-zero = unset) and
`require_kyc: bool` (default false). Their offset therefore depends on the length of `mints`
(`8 + 32 + 1 + 4 + 32·n`).

A wallet is **valid** when its attestation exists, is owned by the program, has `wallet` equal to
the acting wallet, `issuer == Config::issuer`, `level >= 1`, `revoked == false`, and
`expires_at == 0 || expires_at > now`. Anything else is `KycRequired`.

## Instructions

| Instruction | Signer(s) | Notes |
|---|---|---|
| `set_issuer(issuer)` | admin | rejects the zero key (`InvalidIssuer`). Rotating the issuer invalidates every attestation the old key signed |
| `set_require_kyc(required)` | admin | turning it **on** needs an issuer first (`IssuerNotSet`) |
| `attest(level, expires_at, subject_hash)` | `payer` + `issuer` | init-or-update. Level 1..2 (`InvalidAttestationLevel`), non-zero hash (`InvalidSubjectHash`), expiry 0 or future (`AttestationExpiryInPast`), issuer must equal `Config::issuer` (`NotIssuer`) |
| `revoke()` | issuer | marks `revoked`; keeps the record. Idempotent |

Accounts, in wire order (names do nothing on the wire):

- `set_issuer`, `set_require_kyc`: `admin` (writable signer), `config` (writable), `system_program`.
  The `config` account is **reallocated** to the current size (rent topped up by `admin`) before
  either field is written, so a config created before this change is upgraded in place by the first
  call. On a config of current size it is a no-op. This is the account-size/rent check.
- `attest`: `payer` (writable signer), `config`, `issuer` (signer), `wallet`, `attestation`
  (writable PDA), `system_program`.
- `revoke`: `config`, `issuer` (signer), `wallet`, `attestation` (writable PDA).
- `apply`: gained `config` and `attestation` (PDA of the **tenant**). The Anchor client resolves both.
- `propose_lease`: gained `attestation` (PDA of the **landlord**, the acting wallet).
- `fund_deposit`: gained `config` and `attestation` (PDA of the **tenant**).

**Who is checked where.** The tenant is vetted at `apply` **and** at `fund_deposit`; the landlord at
`propose_lease`. `apply` is a convenience, not a prerequisite — a landlord can propose to a tenant
who never applied — so the **binding tenant gate is `fund_deposit`**, the tenant's real
commitment point: an unverified tenant cannot make a lease `Active`, and with it cannot pay rent
or claim a deposit. All three read the same attestation under the same `require_kyc` flag. The
Anchor client resolves `config` and `attestation` itself on all of them (both are PDAs derived from
accounts the caller already passes), so no call site changes.

Events: `Attested { wallet, level, expires_at }`, `AttestationRevoked { wallet }`.

## Key separation

The issuer key is **not** the fee payer key. `attest` takes them as two signers: the fee payer funds
the account's rent, only the issuer's signature authorises it. A leaked sponsor key can pay for
attestations but cannot create one. `backend/src/env.ts` refuses a config where the fee payer,
treasury and issuer keypairs coincide, and refuses to boot `BACKEND_MODE=live` without
`ATTESTATION_ISSUER_KEYPAIR` and `KYC_SUBJECT_SALT`. In mock mode with no issuer key the backend
still serves the flow but writes nothing, and says so (`not-written`, `unavailable`).

## Gate and compatibility

`require_kyc` is **false** by default, so a fresh network, `make test-demo` and the `demo` feature
behave exactly as before; the devnet demo deploy turns it on:

```
ADMIN_KEYPAIR=<config admin> ATTESTATION_ISSUER=<issuer pubkey> node scripts/setup-kyc.ts on
```

`scripts/kyc-e2e.ts` demonstrates the full mock flow against a local Surfpool and backend.

**Upgrade note.** `issuer` and `require_kyc` sit after the variable-length `mints` vector, and the
`realloc` in `SetKycConfig` runs only after the account has deserialized. An *old-layout* Config
holding 7 or 8 mints cannot deserialize under this build (it is 1–2 mints' worth of bytes short),
so every instruction taking `Config` fails and nothing can repair it on chain. Before deploying
this build over such a network, drop to 6 mints or fewer **on the old build**. Fresh deploys, and
old configs with ≤ 6 mints, are unaffected.

## Backend

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/kyc/start` | session | returns `{ url, session, provider, simulated, level, expiresAt }`; wallet comes from the session, never the body |
| `GET /api/kyc/status` | session | reads the on-chain attestation and `Config`: `{ verified, requireKyc, issuer, attestation, pending, last, provider }` |
| `POST /api/webhooks/kyc` | provider signature | the only trigger. Idempotent per vendor event id; a failed chain write is not recorded, so a retry tries again |
| `GET /mock/kyc` | none, mock only | the no-secrets verification page (collects a name it never sends) |

Env: `KYC_PROVIDER=mock|sumsub`, `KYC_LEVEL`, `KYC_VALIDITY_DAYS`, `KYC_SUBJECT_SALT`,
`ATTESTATION_ISSUER_KEYPAIR`, and for Sumsub `SUMSUB_APP_TOKEN`, `SUMSUB_SECRET_KEY`,
`SUMSUB_WEBHOOK_SECRET`, `SUMSUB_API_BASE`, `SUMSUB_LEVEL_NAME`, `SUMSUB_LINK_TTL_SECONDS`,
`SUMSUB_WEBHOOK_DIGEST_ALG`. `KYC_PROVIDER=sumsub` with any key missing fails at boot, and `BACKEND_MODE=live` refuses `KYC_PROVIDER=mock` (the mock verifier is unsigned, and live mode has a real issuer key). `SUMSUB_WEBHOOK_MAX_AGE_SECONDS` (default 600) rejects deliveries whose own `createdAtMs` is further than that from now. `KYC_MAX_STARTS_PER_WALLET_PER_HOUR` (default 10) bounds `/api/kyc/start`.

Privacy: the applicant id is hashed with the secret salt before it is stored; it and the applicant's
documents are never logged or persisted. Records kept in memory hold the wallet, decision, level,
expiry, the hash and signatures.

## Sumsub mapping

> Written to Sumsub's documented API and webhook scheme; **not exercised against the live service**
> (no keys). The verifier is covered by tests with a known secret and body.

| Step | Sumsub | Here |
|---|---|---|
| Start | `POST /resources/sdkIntegrations/levels/{levelName}/websdkLink?externalUserId=…&ttlInSecs=…` signed with `X-App-Token`, `X-App-Access-Ts`, `X-App-Access-Sig = HMAC_SHA256(secretKey, ts + METHOD + path?query + body)` | `kyc-sumsub.ts` `start`; `externalUserId` is the wallet, set only here |
| Webhook auth | `X-Payload-Digest` = hex HMAC of the raw body with the **webhook secret**, algorithm in `X-Payload-Digest-Alg` (`HMAC_SHA1_HEX`, `HMAC_SHA256_HEX`, `HMAC_SHA512_HEX`) | `verifySumsubSignature`, constant-time, over the exact bytes received |
| `applicantReviewed`, `reviewAnswer: GREEN` | applicant passed | `kyc.approved` → `attest(KYC_LEVEL, now + KYC_VALIDITY_DAYS, sha256(applicantId‖salt))` |
| `applicantReviewed`, `reviewAnswer: RED` (`FINAL` or `RETRY`) | applicant failed | `kyc.rejected` → `revoke` if an attestation exists, else nothing |
| `applicantCreated` / `Pending` / `OnHold` / non-final | informational | acknowledged with 200, no chain write |
| Idempotency | no timestamp in the signature, so replays are possible | key = `correlationId` + answer, else applicant + answer + `createdAtMs`; one event attests once |
| Freshness | `createdAtMs` is a UTC string (`2020-02-21 13:23:19.321`) | refused when more than `SUMSUB_WEBHOOK_MAX_AGE_SECONDS` from now, or unreadable, so a captured GREEN cannot re-attest a revoked wallet after a restart empties the dedupe store |

Two secrets, not to be confused: `SUMSUB_SECRET_KEY` signs our requests; `SUMSUB_WEBHOOK_SECRET`
verifies theirs and is set separately in the dashboard.

## App

`app/src/screens/Kyc.tsx` (tab "Verify"): start → verification page → status read back from chain
(level, validity). `ProfileCard` shows a Verified badge; the onboarding checklist's identity step
is done when the chain says so. When the gate is on and the wallet is unverified, `apply` /
`propose_lease` show "Verify your identity first" with a link to the tab instead of the raw error.

TS mirror: `AttestationView` in `backend/src/contracts.ts`.
