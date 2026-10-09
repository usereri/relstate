/**
 * Join class names, dropping falsy ones.
 *
 * Deliberately not the app's clsx + tailwind-merge pair, which the site is too small to need --
 * but that means **this cannot resolve a conflict**. Passing `bg-card` next to a variant's
 * `bg-primary` leaves both on the element and lets stylesheet order pick the winner, so anything
 * that overrides a colour, size or spacing utility belongs in the variant (see `btn`), not here.
 * Layout-only additions (`mt-auto`, `w-full`) are fine.
 */
export const cn = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
