import { cn } from "@/lib/utils";
import "./gamify.css";

interface Props {
  /** 0..100 */
  value: number;
  size?: number;
  stroke?: number;
  /** what the ring is measuring, for screen readers */
  label: string;
  className?: string;
  children?: React.ReactNode;
}

/**
 * The ring around the level mark: how far along the way to the next level the record is.
 *
 * The arc takes its colour from `currentColor`, so the caller sets it with a text colour and the
 * ring follows the role's palette.
 */
export function ProgressRing({ value, size = 76, stroke = 6, label, className, children }: Props) {
  const safe = Math.min(100, Math.max(0, value));
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;

  return (
    <div
      role="img"
      aria-label={`${label}: ${Math.round(safe)}%`}
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--secondary)" strokeWidth={stroke} />
        <circle
          className="gamify-ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - safe / 100)}
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center">{children}</span>
    </div>
  );
}
