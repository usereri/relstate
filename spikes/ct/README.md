# Spike: Token-2022 Confidential Transfer on devnet

Run: `cd spikes/ct && npm i && node spike.mjs` (needs ~/.config/solana/id.json with devnet SOL once; it funds a throwaway `.payer.json`).

Result on 2026-10-07 (devnet, solana-core 4.4.0-beta.0): ALL STEPS PASS
create CT mint -> create+configure two confidential accounts (PubkeyValidity proof via ZK ElGamal program) -> mint -> deposit -> apply pending -> confidential transfer (equality + validity + range proofs).

Notes
- Libs: `@solana-program/token-2022/confidential` (+ `@solana/zk-sdk` wasm) with `@solana/kit` 8.
- A transfer is a multi-transaction plan (proof data + transfer); the public RPC 429s without retry/backoff. Use Helius.
- Keys: `ConfidentialKeys.fromIkm/fromSignature`; for the embedded wallet, derive from a wallet signature of `solana-conf-bal/v1` (see zk-sdk README).
