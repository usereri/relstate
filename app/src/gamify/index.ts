/**
 * Gamification: reputation levels, badges, the level-up moment and the onboarding checklist.
 *
 * Everything here is derived from the on-chain `Profile` counters the program writes. There is no
 * new program state, no backend state and no local tally; the only thing stored in the browser is
 * which change this browser has already celebrated, so a toast fires once.
 *
 * The app touches exactly two of these:
 *   - `Gamify`, mounted once by `App.tsx` (the level-up toast and the checklist);
 *   - `ReputationPanel`, the band inside `ProfileCard`.
 */
export { Gamify } from "./Gamify";
export { ReputationPanel } from "./ReputationPanel";
export { badgesFor } from "./badges";
export type { BadgeId, BadgeState } from "./badges";
export { checklist, onboarded, openSteps } from "./checklist";
export type { OnboardingState, Step, StepState } from "./checklist";
export { celebration, snapshot } from "./celebrate";
export type { Celebration, Seen } from "./celebrate";
export { levelNames, levelOf, standing } from "./levels";
export type { Requirement, Standing } from "./levels";
