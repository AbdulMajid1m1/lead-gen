import { cn, CONFIDENCE_STYLES } from "../lib/format.js";
import { ShieldCheck, ShieldAlert, Sparkles, HelpCircle } from "lucide-react";

const ICON = {
  VERIFIED: ShieldCheck,
  DETECTED: ShieldAlert,
  INFERRED: HelpCircle,
  AI_GENERATED: Sparkles,
};

/**
 * A single value with its confidence.
 *
 * Confidence lives on the *cell*, not the row, because that is how the data
 * really arrives — a phone number we verified ourselves can sit beside an email
 * the AI merely claimed. Collapsing those into one row-level badge would be the
 * most misleading thing this table could do.
 */
export const ConfidenceCell = ({ cell, mono = false, href = null, empty = "—" }) => {
  if (!cell?.value) return <span className="text-[var(--text-subtle)]">{empty}</span>;
  const Icon = ICON[cell.confidenceLevel] || HelpCircle;
  const style = CONFIDENCE_STYLES[cell.confidenceLevel];

  const body = (
    <span className={cn("truncate", mono && "font-mono text-[12px]")}>{cell.value}</span>
  );

  return (
    <span className="flex min-w-0 items-center gap-1.5" title={`${cell.confidenceLevel}${cell.sourceUrl ? ` — seen on ${cell.sourceUrl}` : ""}`}>
      <Icon size={11} className={cn("shrink-0", style?.className?.split(" ").find((c) => c.startsWith("text-")))} />
      {href ? (
        <a href={href} className="min-w-0 truncate hover:text-[var(--accent)] hover:underline" onClick={(e) => e.stopPropagation()}>
          {body}
        </a>
      ) : body}
    </span>
  );
};

/** Legend so the badges are self-explanatory the first time you see them. */
export const ConfidenceLegend = () => (
  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--text-muted)]">
    <span className="font-medium text-[var(--text)]">How sure are we?</span>
    {[
      ["VERIFIED", "we fetched the company's own page and saw it"],
      ["DETECTED", "seen on a third-party page we fetched"],
      ["INFERRED", "concluded from our own rules"],
      ["AI_GENERATED", "the AI said so — not independently confirmed"],
    ].map(([level, meaning]) => {
      const Icon = ICON[level];
      return (
        <span key={level} className="inline-flex items-center gap-1">
          <Icon size={11} className={CONFIDENCE_STYLES[level]?.className?.split(" ").find((c) => c.startsWith("text-"))} />
          <span className="font-medium">{CONFIDENCE_STYLES[level]?.label}</span>
          <span className="text-[var(--text-subtle)]">— {meaning}</span>
        </span>
      );
    })}
  </div>
);
