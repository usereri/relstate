import { ArrowRight, CalendarDays } from "lucide-react";
import { btn } from "@/components/ui";
import { appHref, EVENTS } from "@/lib/links";
import { cn } from "@/lib/utils";

export function Cta() {
  return (
    <section className="px-5 py-16 sm:px-8">
      <div className="relative mx-auto max-w-7xl overflow-hidden rounded-[28px] bg-primary px-8 py-14 text-primary-foreground sm:px-14">
        <div className="grid-paper pointer-events-none absolute inset-0 opacity-30 invert" aria-hidden />
        <div className="relative flex flex-col items-start gap-7 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex max-w-xl flex-col gap-3">
            <h2 className="text-[clamp(1.75rem,4vw,3rem)] font-semibold leading-[1.02]">Moving somewhere new this month?</h2>
            <p className="text-primary-foreground/80">Browse what is available, or start from the reason you are moving.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <a href={appHref()} className={cn(btn({ size: "lg" }), "bg-card text-foreground hover:bg-card/90")}>
              Find a home <ArrowRight />
            </a>
            <a href={EVENTS} className={cn(btn({ size: "lg" }), "border border-primary-foreground/30 bg-transparent text-primary-foreground hover:bg-primary-foreground/10")}>
              <CalendarDays /> What&rsquo;s on in Kraków
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
