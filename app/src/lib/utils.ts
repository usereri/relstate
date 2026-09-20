import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export const short = (s: string, n = 4) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

export const usdc = (baseUnits: number) =>
  (baseUnits / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });

export function duration(secs: number) {
  const s = Math.max(0, Math.round(secs));
  if (s >= 86400) {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    return h ? `${d}d ${h}h` : `${d}d`;
  }
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

/** A web address, a path served by the app, or just a file name from app/public/listings (".jpg" optional). */
export const photoUrl = (p: string) => {
  const s = p.trim();
  if (!s || /^(https?:)?\/\//.test(s) || s.startsWith("/")) return s;
  return `/listings/${/\.[a-z0-9]{2,5}$/i.test(s) ? s : `${s}.jpg`}`;
};
