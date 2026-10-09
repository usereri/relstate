// Registers the connected wallet's session with the sponsor client.
//
// Called once, from `useMe()` — the single place that knows which of the three wallet kinds is
// active — so the extension, the built-in test wallet and the embedded wallet all authenticate the
// same way. Without this, `POST /api/sponsor` answers 401 for everyone in sponsored mode.

import { useEffect } from "react";
import { SPONSORED, setSessionTokenSource } from "@/lib/sponsor";
import { obtainSession } from "./session";

export function useSponsorSession(address: string | null): void {
  useEffect(() => {
    if (!SPONSORED || !address) return;
    // A source rather than a token: `postSponsored` calls it per request, so a session that
    // expired mid-session is renewed instead of failing.
    setSessionTokenSource(async () => (await obtainSession(address)).token);
    return () => setSessionTokenSource(null);
  }, [address]);
}
