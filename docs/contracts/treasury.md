# Contract 6: Treasury (custodial for the demo, stated as such)

| Question | Answer |
|---|---|
| Who holds on-ramped USDC? | Treasury reserve: a backend-owned devnet-USDC token account |
| Who wraps to rUSDC? | Backend, using the treasury mint authority, only after a confirmed on-ramp webhook |
| What triggers wrap? | `onramp.completed` event (Contract 4) -> `treasury.wrap(wallet, amount)` |
| Deposit funding | Backend mints rUSDC to tenant, sponsors `deposit` + `apply pending`; tenant then funds the lease deposit |
| Payout | Landlord withdraws confidential -> public rUSDC (sponsored) -> `treasury.unwrap(wallet, amount)` burns it and releases USDC toward the off-ramp provider (mocked, labelled on stage) |
| Invariant | `rUSDC supply <= reserve USDC balance`, checked after every wrap/unwrap |
| Keys | treasury mint authority + freeze authority, auditor ElGamal secret, fee payer, attestation issuer: four separate keys, all in backend secrets, never in the app |

Honest framing: the peg is a custodial promise backed by a reserve we control; devnet USDC is test-only. A trust-minimised on-chain wrapper is post-demo.
