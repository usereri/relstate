# Contract 3: `Attestation` account (program change owned by workstream D, after the Phase 1 gate)

```rust
#[account]
#[derive(InitSpace)]
pub struct Attestation {
    pub wallet: Pubkey,         // seeds: [b"attestation", wallet]
    pub issuer: Pubkey,         // must equal the ISSUER key in config; NOT the fee payer key
    pub level: u8,              // 0 none, 1 basic, 2 enhanced
    pub verified_at: i64,
    pub expires_at: i64,        // 0 = never; demo uses 1 year
    pub revoked: bool,
    pub subject_hash: [u8; 32], // sha256(applicant_id || salt); no personal data on chain
    pub bump: u8,
}
```

- `attest(level, expires_at, subject_hash)`: signer = issuer; init-or-update. `revoke()`: signer = issuer.
- Separate **issuer key** from the **fee payer key** (a leaked sponsor key must not mint KYC).
- `apply` / `propose_lease` require a valid attestation (level >= 1, not revoked, not expired) for the acting wallet. Missing or stale -> error `KycRequired`.
- Existing test profiles/wallets: gated by a program config flag `require_kyc` (false in tests and in `demo` builds until D lands; true for the devnet demo deploy).
- TS mirror: `AttestationView` in `backend/src/contracts.ts`.
