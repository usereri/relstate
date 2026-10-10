// Lazy wiring. Nothing here touches the network or the filesystem until a route
// actually needs it, which is what lets `GET /health` answer in a fresh clone
// with no secrets and no RPC reachable.
import type { Address } from "@solana/kit";
import { SPONSOR_ALLOWLIST } from "./contracts.ts";
import { env } from "./env.ts";
import { getKey } from "./keys.ts";
import { createRateLimiter } from "./limits.ts";
import { kyc as createKycService, offramp as createOfframpService, onramp as createOnrampService } from "./providers/index.ts";
import { createAttestationChain, type AttestationChain, type AttestationChainRpc } from "./providers/kyc-chain.ts";
import { KycUnavailable, type Kyc } from "./providers/kyc.ts";
import type { Offramp } from "./providers/offramp.ts";
import type { Onramp } from "./providers/onramp.ts";
import { createPlanRunner, getSolanaClient, type SolanaClient } from "./rpc.ts";
import { createSponsorService, defaultSponsorPolicy, type SponsorService } from "./sponsor.ts";
import { createTreasury, type Treasury, type TreasuryRpc } from "./treasury.ts";

export class ServiceUnavailable extends Error {}

export type Services = {
  client(): SolanaClient;
  sponsor(): Promise<SponsorService>;
  treasury(): Promise<Treasury>;
  /** Workstream E. Both are synchronous: neither needs a key or the network to exist. */
  onramp(): Onramp;
  offramp(): Offramp;
  /** Workstream D. Synchronous for the same reason: only the chain write needs keys. */
  kyc(): Kyc;
  /** The attestation writer. Throws `KycUnavailable` when this deployment cannot write one. */
  attestationChain(): Promise<AttestationChain>;
  /** For /health: which keys are throwaways generated for this process. */
  keyReport(): Promise<{ feePayer: string; attestationIssuer: string; treasury: string; ephemeral: string[] }>;
};

export function createServices(log: (...args: unknown[]) => void = console.log): Services {
  const limiter = createRateLimiter();
  let client: SolanaClient | undefined;
  let sponsor: Promise<SponsorService> | undefined;
  let treasury: Promise<Treasury> | undefined;
  let onramp: Onramp | undefined;
  let offramp: Offramp | undefined;
  let kyc: Kyc | undefined;
  let attestationChain: Promise<AttestationChain> | undefined;

  const getClient = () => (client ??= getSolanaClient());

  return {
    client: getClient,

    sponsor() {
      return (sponsor ??= (async () => {
        const feePayer = await getKey("feePayer");
        return createSponsorService({
          rpc: getClient().rpc,
          feePayer: feePayer.signer,
          limiter,
          policy: defaultSponsorPolicy(SPONSOR_ALLOWLIST),
          // An ephemeral fee payer has no on-chain account, so it can neither
          // pay nor be simulated against. Validate, co-sign, return — and say so
          // in the response (`broadcast: false`).
          broadcast: !feePayer.ephemeral,
          simulate: !feePayer.ephemeral,
          log,
        });
      })());
    },

    treasury() {
      return (treasury ??= (async () => {
        if (env.rusdcMint === "") {
          throw new ServiceUnavailable("RUSDC_MINT is not set; run scripts/make-rusdc.ts to create the mint");
        }
        const key = await getKey("treasury");
        const solana = getClient();
        return createTreasury({
          rpc: solana.rpc as TreasuryRpc,
          run: createPlanRunner(solana, log),
          treasury: key.signer,
          mint: env.rusdcMint as Address,
          decimals: env.rusdcDecimals,
          mode: env.mode,
          reserveTokenAccount: env.usdcReserveTokenAccount === "" ? undefined : (env.usdcReserveTokenAccount as Address),
          log,
        });
      })());
    },

    /**
     * The on-ramp takes the treasury as a thunk rather than a value: a checkout
     * must work in a fresh clone where `RUSDC_MINT` is unset, and only the
     * webhook — which mints — actually needs the treasury to exist.
     */
    onramp() {
      return (onramp ??= createOnrampService({ treasury: () => this.treasury(), log }));
    },

    offramp() {
      return (offramp ??= createOfframpService({ treasury: () => this.treasury(), log }));
    },

    /**
     * The attestation writer: the fee payer funds the account, the issuer authorises it.
     *
     * Refuses rather than improvises when either key is a throwaway. An ephemeral key has no
     * lamports, so the fee payer could not pay for the account; an ephemeral *issuer* is worse
     * than useless, because `Config::issuer` names a key that this process generated at boot and
     * will forget on the next one — every attestation it signed would be invalid, and the next
     * restart would sign with a different key again. Saying so is the honest answer, and
     * `KycUnavailable` is what the service turns into a labelled "not written" record.
     */
    attestationChain() {
      return (attestationChain ??= (async () => {
        const [feePayer, issuer] = await Promise.all([getKey("feePayer"), getKey("attestationIssuer")]);
        if (issuer.ephemeral) {
          throw new KycUnavailable("ATTESTATION_ISSUER_KEYPAIR is not set, so there is no issuer key to sign an attestation with");
        }
        if (feePayer.ephemeral) {
          throw new KycUnavailable("FEE_PAYER_KEYPAIR is not set, so there is no funded key to pay for the attestation account");
        }
        const solana = getClient();
        return createAttestationChain({
          rpc: solana.rpc as AttestationChainRpc,
          run: createPlanRunner(solana, log),
          payer: feePayer.signer,
          issuer: issuer.signer,
          log,
        });
      })().catch((error: unknown) => {
        // Not memoised on failure: a missing key is permanent, but an RPC that was down when the
        // first webhook arrived should not poison the rest of the process's life.
        if (!(error instanceof KycUnavailable)) attestationChain = undefined;
        throw error;
      }));
    },

    kyc() {
      return (kyc ??= createKycService({ chain: () => this.attestationChain(), log }));
    },

    async keyReport() {
      const [feePayer, issuer, treasuryKey] = await Promise.all([
        getKey("feePayer"),
        getKey("attestationIssuer"),
        getKey("treasury"),
      ]);
      const ephemeral = [
        feePayer.ephemeral ? "feePayer" : undefined,
        issuer.ephemeral ? "attestationIssuer" : undefined,
        treasuryKey.ephemeral ? "treasury" : undefined,
      ].filter((x): x is string => x !== undefined);
      return {
        feePayer: feePayer.signer.address,
        attestationIssuer: issuer.signer.address,
        treasury: treasuryKey.signer.address,
        ephemeral,
      };
    },
  };
}
