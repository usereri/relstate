import { cn } from "@/lib/utils";
import { HOME } from "@/lib/links";

/**
 * The mark and wordmark, kept byte-for-byte in step with `app/src/components/Brand.tsx`.
 * Duplicated rather than imported: the site is a standalone package with its own dependencies,
 * and a cross-package import would drag the app's build (wasm, Solana) into a static site.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden>
      <rect width="32" height="32" rx="9" fill="currentColor" />
      <path d="M10 25V12.5L16 8l6 4.5V25" fill="none" stroke="var(--background)" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M13.5 25v-6.5h5V25" fill="none" stroke="var(--background)" strokeWidth="2.4" strokeLinejoin="round" />
      <circle cx="16" cy="13.6" r="1.6" fill="var(--brass)" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <a href={HOME} className={cn("flex items-center gap-2.5 rounded-lg text-primary", className)} aria-label="Relstate home">
      <Mark />
      <span className="font-display text-[22px] font-semibold tracking-[-0.03em] text-foreground">relstate</span>
    </a>
  );
}
