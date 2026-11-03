import { ArrowRight } from "lucide-react";
import { Logo } from "@/components/Brand";
import { ThemeToggle } from "@/components/Theme";
import { btn } from "@/components/ui";
import { appHref, EVENTS, HOME } from "@/lib/links";

/** Section anchors live on the home page, so they are addressed through it from either page. */
export const NAV = [
  ["How it works", `${HOME}#how`],
  ["Trust", `${HOME}#trust`],
  ["Privacy", `${HOME}#privacy`],
  ["Events", EVENTS],
  ["FAQ", `${HOME}#faq`],
] as const;

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-transparent bg-background/80 backdrop-blur-md supports-[backdrop-filter]:border-border/60">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-5 sm:px-8">
        <Logo />
        <nav className="hidden items-center gap-1 lg:flex" aria-label="Sections">
          {NAV.map(([label, href]) => (
            <a key={href} href={href} className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
              {label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <ThemeToggle />
          <a href={appHref()} className={btn({ size: "sm" })}>
            Find a home <ArrowRight />
          </a>
        </div>
      </div>
    </header>
  );
}
