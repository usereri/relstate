import { useCallback, useEffect, useState } from "react";
import type { ProfileView, Role } from "@/lib/chain";
import { Celebration, celebration, readSeen, snapshot, writeSeen } from "./celebrate";

/**
 * Watches the profile counters for this wallet and reports the first time they move.
 *
 * `profile` is the value the card already has, so this costs no extra read: the app re-reads the
 * profile on its own tick, and a change between two of those reads is what fires the moment.
 *
 * A null profile is treated as "nothing known yet", not as a profile of zeros. While the read is in
 * flight, and before the program has created the account, there is nothing to compare against, and
 * recording zeros as "seen" would make an established wallet's first real read look like a
 * lifetime of progress happening at once. The program creates the account with every counter at
 * zero, so a genuinely new tenant still gets the full sequence.
 */
export function useLevelUp(address: string | null, role: Role, profile: ProfileView | null | undefined) {
  const [shown, setShown] = useState<Celebration | null>(null);
  const dismiss = useCallback(() => setShown(null), []);

  // a toast belongs to the wallet it was raised for
  useEffect(() => setShown(null), [address, role]);

  // the effect depends on the counter values, not on the object identity the poll hands us
  const seen = profile ? JSON.stringify(snapshot(profile, role)) : null;
  useEffect(() => {
    if (!address || !seen) return;
    const now = JSON.parse(seen) as ReturnType<typeof snapshot>;
    const before = readSeen(address, role);
    writeSeen(address, role, now);
    // first sight of this wallet in this browser: record it, celebrate nothing
    if (!before) return;
    const next = celebration(before, now, role);
    // only ever set: a second pass over the same change (React's strict mode) finds nothing new
    // and must not clear the toast it just raised
    if (next) setShown(next);
  }, [address, role, seen]);

  return { celebration: shown, dismiss };
}
