/**
 * Design tokens — the single source of truth, framework-agnostic.
 *
 * Plain data only: NO imports, NO DOM, NO React. This is the `@krispy/ui/tokens`
 * entry point so React Native can consume it without pulling in the web
 * component layer (Radix / DOM). Values are hex + rem strings so they work in
 * both CSS and RN (`parseFloat` a rem for RN if you need a number).
 *
 * `src/styles/globals.css` mirrors the `colors` / `radii` values below into CSS
 * custom properties for the web (Krispy "Fresh Baked" theme). Keep the two in
 * sync — this file is the source of truth, the CSS is the derived copy.
 * ponytail: hand-mirrored instead of a codegen step. Add codegen only if the
 * token set grows past what's comfortable to keep in sync by eye.
 */

/**
 * Semantic color roles, per theme. Web reads these via CSS vars; RN reads them
 * from here. Light = "Bakery", dark = "Espresso". The trailing block (gold…espresso)
 * are the Krispy brand accents that live as top-level CSS vars in globals.css.
 */
export const colors = {
  light: {
    background: "#fbf6ee", // warm butter-cream — never pure white
    foreground: "#241a12", // espresso near-black
    card: "#fffdf9",
    cardForeground: "#241a12",
    popover: "#fffdf9",
    popoverForeground: "#241a12",
    primary: "#e39a2b", // Krispy gold
    primaryForeground: "#241a12", // espresso text on gold
    secondary: "#f6d9a8", // butter
    secondaryForeground: "#3a2a17",
    muted: "#f3ece0",
    mutedForeground: "#6b5d4f",
    accent: "#eef23b", // acid butter — loud, sparse
    accentForeground: "#241a12",
    destructive: "#c0432e", // warm brick, never fire-truck
    destructiveForeground: "#ffffff",
    border: "#eadfcf", // warm hairline
    input: "#eadfcf",
    ring: "#e39a2b",
    // Krispy accents (bold layer)
    gold: "#e39a2b",
    goldHover: "#c9841c",
    butter: "#f6d9a8",
    crust: "#9e5a22",
    acid: "#eef23b",
    jam: "#f0426b",
    fresh: "#2fbf9e", // pistachio — LIVE/online/success ONLY
    cream: "#fbf6ee",
    espresso: "#241a12",
  },
  dark: {
    background: "#191009",
    foreground: "#f7efe2",
    card: "#241811",
    cardForeground: "#f7efe2",
    popover: "#241811",
    popoverForeground: "#f7efe2",
    primary: "#f2b950", // brighter gold on dark
    primaryForeground: "#191009",
    secondary: "#3a2a17",
    secondaryForeground: "#f7efe2",
    muted: "#2a1d12",
    mutedForeground: "#b7a794",
    accent: "#eef23b",
    accentForeground: "#191009",
    destructive: "#e5675a",
    destructiveForeground: "#191009",
    border: "#3a2c1e",
    input: "#3a2c1e",
    ring: "#f2b950",
    gold: "#f2b950",
    goldHover: "#e3a63a",
    butter: "#3a2a17",
    crust: "#c98a4a",
    acid: "#eef23b",
    jam: "#f0426b",
    fresh: "#45d6b0",
    cream: "#f7efe2",
    espresso: "#f7efe2",
  },
} as const;

/** Raw Krispy-gold ramp, in case a product needs a specific step outside the semantic roles. */
export const brand = {
  50: "#fdf6ea",
  100: "#f8e6c4",
  200: "#f0cf8f",
  300: "#e8b257",
  400: "#e39a2b", // gold
  500: "#c9841c", // gold-hover
  600: "#a86a14",
  700: "#874f0f",
  800: "#6a3d0c",
  900: "#4e2c09",
  950: "#2c1905",
} as const;

/** Spacing scale (rem). Matches Tailwind's 4px base at `spacing.1`. */
export const spacing = {
  0: "0rem",
  px: "1px",
  1: "0.25rem",
  2: "0.5rem",
  3: "0.75rem",
  4: "1rem",
  5: "1.25rem",
  6: "1.5rem",
  8: "2rem",
  10: "2.5rem",
  12: "3rem",
  16: "4rem",
  20: "5rem",
  24: "6rem",
} as const;

/**
 * Border radius scale (rem). `base` mirrors the CSS `--radius` (0.75rem).
 * Krispy is rounded-friendly: `sm` 8px buttons/inputs, `md` 12px cards/bubbles,
 * `pill` for tags + the live badge.
 */
export const radii = {
  none: "0rem",
  sm: "0.5rem", // 8px — buttons, inputs
  md: "0.75rem", // 12px — cards, chat bubbles
  base: "0.75rem", // CSS --radius anchor
  lg: "0.75rem",
  xl: "1rem",
  pill: "999px",
  full: "9999px",
} as const;

export const typography = {
  fontFamily: {
    // Web resolves these via CSS vars set by next/font (--font-*); the trailing
    // names are the RN + Storybook fallbacks.
    display: '"Fraunces", Georgia, "Times New Roman", serif',
    sans: '"Bricolage Grotesque", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    mono: '"Geist Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
  fontSize: {
    xs: "0.75rem",
    sm: "0.875rem",
    base: "1rem",
    lg: "1.125rem",
    xl: "1.25rem",
    "2xl": "1.5rem",
    "3xl": "1.875rem",
    "4xl": "2.25rem",
    "5xl": "3rem",
    "6xl": "3.75rem",
  },
  fontWeight: {
    normal: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
    black: "900", // the landing leans on font-black display
  },
  lineHeight: {
    tight: "1.15",
    normal: "1.5",
    relaxed: "1.75",
  },
} as const;

/** Motion — mirrors the `--ease-*` curves in globals.css (exponential ease-out, no bounce). */
export const easing = {
  quart: "cubic-bezier(0.25, 1, 0.5, 1)",
  quint: "cubic-bezier(0.22, 1, 0.36, 1)",
  expo: "cubic-bezier(0.16, 1, 0.3, 1)",
} as const;

export const tokens = {
  colors,
  brand,
  spacing,
  radii,
  typography,
  easing,
} as const;

export type Tokens = typeof tokens;
export type ColorTheme = keyof typeof colors;
export type ColorRole = keyof typeof colors.light;
