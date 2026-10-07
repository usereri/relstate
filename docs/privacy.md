# Privacy design (Phase 1, step 0)

Settled decisions for the demo. Change only by agreement.

## What is hidden, what is public

| Data | Visibility | Why |
|---|---|---|
| Amount of every rent payment and deposit transfer (rUSDC confidential transfer) | **Hidden** (encrypted) | the pitch: "settled amounts are private" |
| Listing price, `Lease.rent_amount`, `deposit_amount`, term | **Public** | the program computes discounts and default arithmetic on them; moving to commitments is out of scope |
| That a payment happened, who paid whom, when | Public | reputation counters need it |
| Contract text | Never on chain; only SHA-256 (`lease_hash`) | already true |
| KYC personal data | Never on chain or in our DB; stays with Sumsub. Chain holds `subject_hash` + level | |

Pitch wording: "what you pay each month is between you and your landlord", NOT "lease terms are secret".

## Keys

- Each wallet derives ElGamal + AES keys from a wallet signature of `solana-conf-bal/v1` (`ConfidentialKeys.fromSignature`). Embedded wallet must expose `signMessage` via a dedicated key-derivation call, never generic signing.
- Landlord decrypts own incoming balance with own key.
- **Auditor key** (ElGamal) set on the rUSDC mint, held only in backend secrets. Lets us decrypt any transfer for compliance and to verify payments.

## What `pay_rent` can and cannot enforce

The program cannot see a hidden amount. `pay_rent` therefore:

1. requires, via instruction introspection, a Token-2022 confidential `Transfer` instruction in the same transaction whose source is the tenant's token account and destination is the landlord's token account for the lease mint;
2. records that a payment happened (counters, timing, on-time/late).

It does NOT verify the amount equals `rent_amount`. Residual gap: a tenant could send a wrong amount and still get credit. For the demo the backend (auditor key) verifies amount = rent after the fact and can flag/revoke; this is stated openly. Post-demo options: backend co-signs the payment only after decrypting the proof inputs, or amount commitments checked on chain.

## Out of scope for the demo

Hiding the sender/receiver graph, hiding listing prices, trust-minimised wrapper (see treasury contract).
