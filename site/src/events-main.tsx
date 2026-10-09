import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowRight, CalendarDays, GraduationCap, Info, MapPin, PartyPopper } from "lucide-react";
import "./index.css";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { SkipLink } from "@/components/SkipLink";
import { btn } from "@/components/ui";
import { CITIES, dateLabel, EVENTS, EVENTS_NOTE, type EventEntry } from "@/data/events";
import { appHref } from "@/lib/links";
import { cn } from "@/lib/utils";

/** The whole point of the page: an occasion turns into a search in the app. */
const bookNearbyHref = (e: EventEntry) =>
  appHref({ role: "tenant", city: e.city, near: `${e.lat},${e.lng}`, radius: e.radiusKm, label: e.venue });

function EventsPage() {
  const [city, setCity] = useState<string | null>(null);
  const shown = city ? EVENTS.filter((e) => e.city === city) : EVENTS;

  return (
    <div className="min-h-dvh overflow-x-clip">
      <SkipLink />
      <Nav />
      <main id="main">
        <section className="relative border-b">
          <div className="grid-paper pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black_30%,transparent_75%)]" aria-hidden />
          <div className="relative mx-auto flex max-w-7xl flex-col gap-6 px-5 py-14 sm:px-8 lg:py-20">
            <p className="eyebrow">Events &amp; universities</p>
            <h1 className="max-w-3xl text-[clamp(2.1rem,5vw,3.75rem)] font-semibold leading-[1.02]">
              Most people move for a reason. Start from yours.
            </h1>
            <p className="max-w-2xl text-lg leading-relaxed text-muted-foreground">
              A semester, a conference, a festival, a first job. Pick the thing you are arriving for and go straight to apartments within walking
              distance of it.
            </p>

            <p className="flex max-w-2xl items-start gap-2.5 rounded-xl border border-warning/35 bg-warning-soft px-4 py-3 text-sm text-warning">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                <strong className="font-semibold">Sample data.</strong> The places are real and the coordinates are approximate, but these occasions
                and dates are placeholders written for the demo. No organisation here is a partner of Relstate.
              </span>
            </p>
          </div>
        </section>

        <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8 lg:py-16">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by city">
            <Filter active={city === null} onClick={() => setCity(null)}>
              All cities
            </Filter>
            {CITIES.map((c) => (
              <Filter key={c} active={city === c} onClick={() => setCity(c)}>
                {c}
              </Filter>
            ))}
            <p aria-live="polite" className="ml-auto text-sm text-muted-foreground">
              {shown.length} {shown.length === 1 ? "entry" : "entries"}
            </p>
          </div>

          <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((e) => (
              <EventCard key={e.id} e={e} />
            ))}
          </ul>

          <p className="mt-10 max-w-3xl text-xs leading-relaxed text-muted-foreground">{EVENTS_NOTE}</p>
        </div>
      </main>
      <Footer />
    </div>
  );
}

function Filter({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-9 rounded-lg border px-3.5 text-sm font-medium transition-colors",
        active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function EventCard({ e }: { e: EventEntry }) {
  const Icon = e.kind === "university" ? GraduationCap : PartyPopper;
  return (
    <li className="flex flex-col gap-4 rounded-[22px] border bg-card p-6 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
            e.kind === "university" ? "bg-jade-soft text-jade" : "bg-secondary text-secondary-foreground",
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          {e.kind === "university" ? "University" : "Event"}
        </span>
        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">sample</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <h2 className="text-xl font-semibold leading-tight">{e.name}</h2>
        <p className="text-sm font-medium text-foreground">{e.venue}</p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <MapPin className="size-3.5 shrink-0" aria-hidden /> {e.city} · {e.area}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays className="size-3.5 shrink-0" aria-hidden /> {dateLabel(e)}
          </span>
        </p>
      </div>

      <p className="text-sm leading-relaxed text-muted-foreground">{e.blurb}</p>

      <a href={bookNearbyHref(e)} className={cn(btn({ variant: "outline" }), "mt-auto w-full")}>
        Book nearby <ArrowRight />
      </a>
      <p className="text-center text-xs text-muted-foreground">Apartments within {e.radiusKm} km of {e.venue}</p>
    </li>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EventsPage />
  </StrictMode>,
);
