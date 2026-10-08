// Lazy wiring. Nothing here touches the network or the filesystem until a route
// actually needs it, which is what lets `GET /health` answer in a fresh clone
// with no secrets and no RPC reachable.
import type { Address } from "@solana/kit";
import { SPONSOR_ALLOWLIST } from "./contracts.ts";
import { env } from "./env.ts";
import { getKey } from "./keys.ts";
import { createRateLimiter } from "./limits.ts";
import { createPlanRunner, getSolanaClient, type SolanaClient } from "./rpc.ts";
import { createSponsorService, defaultSponsorPolicy, type SponsorService } from "./sponsor.ts";
import { createTreasury, type Treasury, type TreasuryRpc } from "./treasury.ts";

export class ServiceUnavailable extends Error {}

export type Services = {
  client(): SolanaClient;
  sponsor(): Promise<SponsorService>;
  treasury(): Promise<Treasury>;
  /** For /health: which keys are throwaways generated for this process. */
  keyReport(): Promise<{ feePayer: string; attestationIssuer: string; treasury: string; ephemeral: string[] }>;
};

export function createServices(log: (...args: unknown[]) => void = console.log): Services {
  const limiter = createRateLimiter();
  let client: SolanaClient | undefined;
  let sponsor: Promise<SponsorService> | undefined;
  let treasury: Promise<Treasury> | undefined;

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
