# Brand

The **source of truth is `frontend/src/index.css`** (tokens) and
`frontend/src/components/Logo.jsx` (mark) — this document explains the shape and
the reasoning.

## 1. The mark

An **L** — Lead — whose corner is turned rather than mitred, with a **beacon
node** in the counter — Signal. Two shapes, nothing else.

That constraint is not minimalism for its own sake. The mark has to survive as a
16px favicon, and every richer idea tried there failed:

| Rejected | Why |
| --- | --- |
| Concentric signal arcs | Reads as the RSS icon at every size |
| Radar reticle | Tick marks collapse into a ring below ~24px |
| Scattered "signal field" | Reads as a sun or a gear when the dots merge |
| Pulse waveform | Becomes an indistinct squiggle at 16px |
| Signal bars | Indistinguishable from the stock analytics icon it replaced |

The letterform proportions matter more than they look like they should. The
first cut had an arm/cap-height ratio of 0.84 and read as a lowercase **u** in
the sidebar. The shipped ratio is **0.60**, with a **3.4** corner radius on a
24-unit grid — that is what makes it read as an L rather than a cup.

### Geometry (24-unit grid)

```
path   M6.9 4.6 V15.0 A3.4 3.4 0 0 0 10.3 18.4 H15.2   stroke 2.8, round cap + join
node   circle cx 16.4  cy 7.4  r 2.5
offset translate(-0.2 0.5)     — optical centring; margins land at 5.3 on both axes
```

`public/favicon.svg` carries the same geometry at 2x on a 48-unit grid, with the
gradient baked to hex because a favicon cannot read custom properties. **Change
one and change the other** — there is no build step keeping them in sync.

### Forms

| Form | Component | Use |
| --- | --- | --- |
| Lockup | `<Logo />` | Sidebar, anywhere the product is named |
| Tile | `<LogoMark />` | Login screen, favicon, app icon, avatars |
| Glyph | `<LogoGlyph />` | Inherits `currentColor`; single-colour contexts only |

Clear space around the tile is **one quarter of the tile edge** on all sides.
Below 16px, drop the wordmark and use the tile alone.

Do not: recolour the tile per theme, outline the wordmark, set the wordmark in
another face, or place the glyph on a background it does not contrast with.

## 2. Colour

### Brand — fixed

These do **not** flip between light and dark. A logo that changes colour with the
theme is two logos, and the favicon cannot follow the theme anyway.

| Token | Value | Hex |
| --- | --- | --- |
| `--color-brand-from` | `oklch(0.688 0.128 42)` | `#dc7e58` |
| `--color-brand-to` | `oklch(0.565 0.135 35)` | `#b7543b` |
| `--color-brand-fg` | `oklch(0.985 0.008 60)` | `#fef9f5` |

`--brand-gradient` is the two stops at 135°.

### Accent — theme-aware

The UI accent is the same burnt orange, but its lightness flips so controls stay
legible on both grounds: `accent-600` in light, `accent-400` in dark. The ramp is
anchored on `accent-500` = `#d97757`.

Every text/background pair in the system clears **4.5:1**. The two that were
tuned specifically to get there: muted text on light surface, and the light-mode
primary button — `#d97757` itself is only 3.1:1 on white, which is why the light
accent is the deeper `accent-600` and why autolinked URLs in outbound email use
`#b8563a`.

### Neutrals

Warm, hue 95–106, chroma under 0.01 — grey, not beige. Dark surfaces are
`#1F1E1D` / `#262624` / `#191817`; light surfaces are `#F7F5F0` / `#FEFDFA` /
`#F0EEE6`. Neither theme uses pure black or pure white.

Semantics sit clear of the accent hue on purpose: caution is pushed to yellow
(85) and critical to red (20), so neither can be misread as a primary action now
that the primary is orange.

## 3. Wordmark

"LeadSignal", one word, capital L and capital S, set in **Inter Semibold** at
`-0.02em` tracking. Live text, never outlines — it stays crisp at any zoom and
inherits the theme's text colour. Never "Lead Signal", "Leadsignal" or "LEADSIGNAL".

## 4. Assets

| File | What |
| --- | --- |
| `frontend/public/favicon.svg` | 48-unit tile, gradient baked to hex |
| `frontend/public/apple-touch-icon.png` | 180x180, rendered from the SVG, no transparent margin |
| `frontend/src/components/Logo.jsx` | All three React forms |

The apple-touch icon is generated from the SVG rather than drawn separately, so
it cannot drift. Regenerate it after any geometry change — iOS crops to its own
squircle, so the tile is drawn edge to edge with no padding of its own.
