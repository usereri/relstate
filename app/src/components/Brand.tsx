import { useEffect, useState } from "react";
import { parseRoute, type Route } from "@/lib/route";
import { cn } from "@/lib/utils";

/** The mark: a door frame whose lintel is a ledger line. */
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

export function Logo({ className, onClick }: { className?: string; onClick?: () => void }) {
  return (
    <a
      href="#/"
      onClick={onClick}
      className={cn("flex items-center gap-2.5 rounded-lg text-primary", className)}
      aria-label="Relstate home"
    >
      <Mark />
      <span className="font-display text-[22px] font-semibold tracking-[-0.03em] text-foreground">relstate</span>
    </a>
  );
}

/**
 * The current route, re-read whenever the hash changes. The router itself is in `@/lib/route`,
 * which is free of React; this is only the subscription.
 */
export function useRoute(): Route {
  const [r, setR] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => {
      setR(parseRoute(location.hash));
      // in-page anchors (#how etc.) are handled by the browser; route changes start at the top
      if (location.hash.startsWith("#/")) window.scrollTo({ top: 0 });
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return r;
}
