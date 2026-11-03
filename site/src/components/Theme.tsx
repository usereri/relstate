import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

const KEY = "relstate.theme";
type Theme = "light" | "dark";

const stored = (): Theme | null => {
  try {
    const t = localStorage.getItem(KEY);
    return t === "dark" || t === "light" ? t : null;
  } catch {
    return null; // private mode: follow the system and forget the choice
  }
};

/**
 * Light/dark switch. With no stored choice the site follows `prefers-color-scheme`, so the
 * `data-theme` attribute is only ever set once the visitor has actually chosen. The matching
 * pre-paint script lives in each page's <head>.
 */
export function ThemeToggle() {
  const [choice, setChoice] = useState<Theme | null>(stored);
  const [system, setSystem] = useState<Theme>(() =>
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );

  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSystem(mq.matches ? "dark" : "light");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    if (choice) document.documentElement.dataset.theme = choice;
    else delete document.documentElement.dataset.theme;
  }, [choice]);

  const theme = choice ?? system;
  const next = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={() => {
        setChoice(next);
        try {
          localStorage.setItem(KEY, next);
        } catch {
          /* the choice still applies for this page */
        }
      }}
      className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
      aria-label={`Switch to ${next} theme`}
    >
      {theme === "dark" ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
    </button>
  );
}
