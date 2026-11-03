import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The app's `buttonVariants` (app/src/components/ui/button.tsx) as a plain class helper. The site
 * only ever renders links, never form buttons, so there is no component wrapper.
 */
/**
 * Every variant has to be declared here rather than patched at the call site: `cn` is a plain
 * join, so passing `bg-card` alongside the default variant's `bg-primary` leaves both classes on
 * the element and lets stylesheet order decide the winner.
 */
export function btn(
  {
    variant = "default",
    size = "default",
  }: { variant?: "default" | "outline" | "ghost" | "onPrimary" | "onPrimaryOutline"; size?: "default" | "sm" | "lg" } = {},
) {
  return cn(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-[15px] font-medium transition-all active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
    variant === "default" && "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
    variant === "outline" && "border border-input bg-card text-foreground hover:bg-secondary/50",
    variant === "ghost" && "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
    // the two that sit on the primary-coloured CTA band, where `bg-primary` would be invisible
    variant === "onPrimary" && "bg-card text-foreground shadow-sm hover:bg-card/90",
    variant === "onPrimaryOutline" && "border border-primary-foreground/35 text-primary-foreground hover:bg-primary-foreground/10",
    size === "default" && "h-12 px-5",
    size === "sm" && "h-9 rounded-lg px-3 text-sm",
    size === "lg" && "h-14 px-6 text-base",
  );
}

export function SectionHead({ eyebrow, title, text, id, tone }: { eyebrow: string; title: string; text?: ReactNode; id?: string; tone?: "panel" }) {
  return (
    <div id={id} className="flex max-w-2xl scroll-mt-24 flex-col gap-4">
      <p className={cn("eyebrow", tone === "panel" && "text-panel-foreground/55")}>{eyebrow}</p>
      <h2 className="text-[clamp(1.9rem,4vw,3.25rem)] font-semibold leading-[1.02]">{title}</h2>
      {text && <p className={cn("text-lg leading-relaxed", tone === "panel" ? "text-panel-foreground/75" : "text-muted-foreground")}>{text}</p>}
    </div>
  );
}

/** A full-width band. `panel` is the contrast band the app uses for its "how it works" section. */
export function Section({ id, tone, className, children }: { id?: string; tone?: "card" | "panel"; className?: string; children: ReactNode }) {
  return (
    <section
      id={id}
      className={cn(
        "scroll-mt-16",
        tone === "card" && "border-y bg-card",
        tone === "panel" && "bg-panel text-panel-foreground",
        className,
      )}
    >
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 lg:py-28">{children}</div>
    </section>
  );
}
