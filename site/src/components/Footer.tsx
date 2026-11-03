import { FlaskConical } from "lucide-react";
import { Logo } from "@/components/Brand";
import { NAV } from "@/components/Nav";

export function Footer() {
  return (
    <footer className="border-t bg-card">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-5 py-12 sm:px-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <Logo />
          <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground" aria-label="Footer">
            {NAV.map(([label, href]) => (
              <a key={href} href={href} className="hover:text-foreground">
                {label}
              </a>
            ))}
          </nav>
        </div>

        {/* The one claim the whole site has to be loud about. */}
        <p className="flex items-start gap-2.5 rounded-xl border border-warning/35 bg-warning-soft px-4 py-3 text-sm font-medium text-warning">
          <FlaskConical className="mt-0.5 size-4 shrink-0" />
          Demo on Solana devnet, test money only.
        </p>

        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>
            Relstate is a hackathon prototype. It is not a bank, a payment institution or a licensed financial service, it holds no customer money, and
            nothing on this site is an offer of housing or an offer of credit. Card payments run in a payment provider&rsquo;s test mode; no real money
            moves.
          </p>
          <p>© 2026 Relstate · Built on Solana</p>
        </div>
      </div>
    </footer>
  );
}
