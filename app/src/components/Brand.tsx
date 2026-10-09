import { useEffect, useState } from "react";
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

/** Tiny hash router: #/, #/signup, #/signin, #/app. */
export type Route = "home" | "signup" | "signin" | "app";
const parse = (): Route => {
  const h = location.hash.replace(/^#\/?/, "").split(/[?#]/)[0];
  return h === "signup" || h === "signin" || h === "app" ? h : "home";
};
export const go = (r: Route) => {
  location.hash = r === "home" ? "/" : `/${r}`;
};
export function useRoute(): Route {
  const [r, setR] = useState(parse);
  useEffect(() => {
    const on = () => {
      setR(parse());
      // in-page anchors (#how etc.) are handled by the browser; route changes start at the top
      if (location.hash.startsWith("#/")) window.scrollTo({ top: 0 });
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return r;
}
