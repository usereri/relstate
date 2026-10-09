import * as chain from "@/lib/chain";
import type { Role } from "@/lib/chain";
import { useChain } from "@/lib/useChain";
import { LevelUpToast } from "./LevelUpToast";
import { OnboardingChecklist } from "./OnboardingChecklist";
import { standing } from "./levels";
import { useLevelUp } from "./useLevelUp";

interface Props {
  role: Role;
  address: string | null;
  /** lease-mint balance in base units, or null when the wallet has no token account */
  balance: number | null;
  /** the onboarding checklist belongs above the listings, so only that tab asks for it */
  showChecklist: boolean;
}

/**
 * The one place the app mounts the gamification pieces.
 *
 * It lives outside the tab switch so the level-up moment can fire wherever the tenant happens to
 * be — paying rent on the lease tab is exactly when it should land — and reads the connected
 * wallet's profile on the app's own tick to notice it.
 */
export function Gamify({ role, address, balance, showChecklist }: Props) {
  const profile = useChain(() => (address ? chain.loadProfile(address) : Promise.resolve(null)), [address]);
  const { celebration, dismiss } = useLevelUp(address, role, profile);

  return (
    <>
      {celebration && (
        <LevelUpToast
          // keyed by content: the app re-renders every few seconds and the toast's own
          // dismiss timer must not restart with it
          key={`${celebration.title}·${celebration.detail}`}
          celebration={celebration}
          standing={standing(profile ?? null, role)}
          onDismiss={dismiss}
        />
      )}
      {showChecklist && <OnboardingChecklist address={address} balance={balance} profile={profile} />}
    </>
  );
}
