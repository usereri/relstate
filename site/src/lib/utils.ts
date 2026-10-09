/** Join class names, dropping falsy ones. The site never conditionally overrides a Tailwind
 *  utility with a conflicting one, so it does not need the app's clsx + tailwind-merge pair. */
export const cn = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
