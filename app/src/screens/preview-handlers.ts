// Inert handlers for the developer preview pages, in one place.
//
// Both preview entries (`src/events/preview.tsx`, `src/screens/preview.tsx`) mount real screens
// against invented data with no chain and no wallet, so every action has to be a no-op. Each of
// them used to carry its own copy of this object, which meant a new handler on `Handlers` broke
// both of them in the same way and in two places.
//
// Nothing here ships: neither preview is an entry in `vite.config.ts`.
import type { Handlers } from "@/screens";

const no = async () => false;

/** Every handler, doing nothing. Spread it and override only what a preview wants to react to. */
export const previewHandlers = (over: Partial<Handlers> = {}): Handlers => ({
  busy: null,
  createListing: no,
  closeListing: no,
  apply: no,
  closeApplication: no,
  propose: no,
  fund: no,
  pay: no,
  release: no,
  markDefault: no,
  claim: no,
  acceptDeduction: no,
  abandonDispute: no,
  escalateToMediation: no,
  proposeAppraisers: no,
  pickAppraiser: no,
  proposeAppraiserKey: no,
  confirmAppraiserKey: no,
  inviteAppraiser: async () => null,
  expireMediation: no,
  finalizeDeduction: no,
  jump: no,
  ...over,
});
