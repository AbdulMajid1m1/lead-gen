import { cn } from "../lib/format.js";

/*
 * The LeadSignal mark.
 *
 * An L (Lead) with a turned rather than mitred corner, and a beacon node in the
 * counter (Signal). Two shapes and nothing else — the mark has to survive as a
 * 16px favicon, and every extra stroke that was tried there collapsed into mush.
 *
 * The tile gradient comes from --brand-*, not --accent-*, on purpose: the accent
 * flips lightness between light and dark so buttons stay legible, but a logo
 * that changes colour with the theme is two logos. These tokens are fixed, so
 * the sidebar, the login screen and public/favicon.svg are the same object.
 *
 * public/favicon.svg holds the same geometry at 2x with the gradient baked to
 * hex. Change one and change the other.
 */

/** The glyph alone, on a 24x24 grid, inheriting the current text colour. */
export const LogoGlyph = ({ size = 24, className, ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    className={className}
    {...props}
  >
    <g transform="translate(-0.2 0.5)">
      <path
        d="M6.9 4.6 V15.0 A3.4 3.4 0 0 0 10.3 18.4 H15.2"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16.4" cy="7.4" r="2.5" fill="currentColor" />
    </g>
  </svg>
);

/**
 * The glyph in its brand tile — the app-icon form, and the one that matches the
 * favicon. `size` is the tile edge in pixels; the glyph and corner radius scale
 * with it so the proportions hold from 20px to 64px.
 */
export const LogoMark = ({ size = 28, className, ...props }) => (
  <span
    className={cn("inline-flex shrink-0 items-center justify-center", className)}
    style={{
      width: size,
      height: size,
      borderRadius: size * 0.26,
      backgroundImage: "var(--brand-gradient)",
      boxShadow: "0 2px 10px var(--accent-glow)",
      color: "var(--color-brand-fg)",
    }}
    {...props}
  >
    <LogoGlyph size={size * 0.66} />
  </span>
);

/**
 * Mark plus wordmark. The wordmark is live text rather than outlines so it stays
 * crisp at every zoom level and inherits the theme's text colour.
 */
export const Logo = ({ size = 28, className, ...props }) => (
  <span className={cn("inline-flex items-center gap-2.5", className)} {...props}>
    <LogoMark size={size} />
    <span
      className="font-semibold tracking-tight"
      style={{ fontSize: size * 0.5, letterSpacing: "-0.02em" }}
    >
      LeadSignal
    </span>
  </span>
);
