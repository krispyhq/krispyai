# Krispy AI — Design Lock

**Status:** Draft v1 (founding). The canonical *visual* system for Krispy — tokens,
type, motion, components, and the "we don't do this" list. Companion to
[`brand-soul.md`](./brand-soul.md) (voice/positioning). This doc is the *skin*; that
one is the *soul*. When they conflict, soul wins.

**System name:** *Fresh Baked* — warm bakery + crisp developer-tool precision. The
whole system lives on one axis (straight from brand-soul): **warm & open, not cold &
closed.** Warmth comes from cream, butter-gold, and soft edges; crispness from
near-black ink, tight mono, and real contrast. If a screen feels like Intercom, it's
wrong. If it feels like a good dev tool that a bakery art-directed, it's right.

---

## 1. Principles (win over any single token)

1. **Warm, not corporate.** Cream over cold white. A gold that looks *baked*, not
   "fintech yellow." Every default bends toward founder-who-cares.
2. **Crisp, not soft-focus.** Warmth is not mush — high contrast ink, sharp mono,
   confident type. Krispy is *crispy*.
3. **Code is decoration.** It's a dev tool. The install snippet, the `<script>` tag,
   the JSON — these are hero elements, set in mono, not hidden in docs.
4. **Playful in the details, serious in the substance.** The croissant, the "let the
   bot cook" wink, a bounce on hover — earned by rock-solid, legible layout.
5. **Effortless motion.** Gen-z cool = nothing feels laborious. Smooth, quick, a hint
   of spring. Never stiff, never slow.
6. **Restraint on color.** Gold does the work. The pistachio "live" pop appears only
   where a human is genuinely present. Everything else is ink on cream.

---

## 2. Color tokens (locked)

Two themes: **Bakery** (light, default) and **Espresso** (dark). Use CSS vars, never
raw hex.

### Bakery (light — default)
| Token | Hex | Role |
|---|---|---|
| `--bg` | `#FBF6EE` | Warm butter-cream page background. Never pure white. |
| `--surface` | `#FFFDF9` | Cards / raised surfaces (warm white). |
| `--ink` | `#241A12` | Primary text — warm espresso near-black. |
| `--ink-soft` | `#6B5D4F` | Secondary text, muted cocoa. |
| `--gold` | `#E39A2B` | **Krispy gold** — the primary brand + CTA color. Baked, not neon. |
| `--gold-hover` | `#C9841C` | CTA hover / pressed. |
| `--butter` | `#F6D9A8` | Soft fills, highlights, tag backgrounds. |
| `--crust` | `#9E5A22` | Deep caramel — secondary accent, depth, borders on gold. |
| `--fresh` | `#2FBF9E` | **Pistachio "live" pop** — ONLY for human-present / online / success. |
| `--line` | `#EADFCF` | Warm hairline borders. |
| `--danger` | `#C0432E` | Errors (warm brick, never fire-truck red). |

### Espresso (dark)
| Token | Hex | Role |
|---|---|---|
| `--bg` | `#191009` | Deep espresso. |
| `--surface` | `#241811` | Raised surface. |
| `--ink` | `#F7EFE2` | Cream text. |
| `--ink-soft` | `#B7A794` | Muted. |
| `--gold` | `#F2B950` | Brighter gold for dark bg. |
| `--butter` | `#3A2A17` | Dark butter fill. |
| `--fresh` | `#45D6B0` | Live pop. |
| `--line` | `#3A2C1E` | Hairline. |

### Banned color
- **No cold blue-grey SaaS palette.** No `#F3F4F6` / Intercom blue / Slack aubergine.
- **No neon.** The gold is baked amber; the pistachio is soft. Nothing glows.
- **Pistachio is sacred** — it means "a human is here / it worked." Don't spend it on
  decoration; it's the one signal color.

---

## 3. Typography (locked)

Three families, one role each. Loaded via `next/font`.

| Var | Family | Role |
|---|---|---|
| `--font-display` | **Fraunces** (variable, `opsz`) | Big warm headlines, hero moments. Soft-serif with baked personality — the "fresh" in Fresh Baked. |
| `--font-ui` | **Geist** (Inter fallback) | All UI + body. Crisp, modern, dev-tool-neutral. |
| `--font-mono` | **Geist Mono** (JetBrains Mono fallback) | Code, install commands, JSON, technical labels, eyebrows. Mono *is* part of the brand. |

**The axis in type:** oversized warm **Fraunces** display ↔ tight **Geist Mono**
labels. That contrast (soft serif vs. hard mono) *is* warm-&-crisp made visible.

- **Hero:** Fraunces ~`clamp(2.75rem, 8vw, 5rem)`, weight 400–500, tight leading
  (1.05), slight negative tracking. Lowercase or sentence case — never SHOUTING CAPS.
- **Section titles:** Fraunces `clamp(1.75rem, 4vw, 2.5rem)`.
- **Body:** Geist, 16–18px, line-height 1.6.
- **Eyebrows / labels / kbd:** Geist Mono, 12–13px, uppercase, `letter-spacing 0.08em`.
  (e.g. `01 — HOW IT WORKS`, `$ npx krispy init`.)
- **Code blocks:** Geist Mono on `--surface`/espresso, warm syntax tint.

### Banned type
- No cold tech-default Inter *as the display face* (Inter is a body fallback only).
- No ALL-CAPS headlines (that's enterprise). Caps live only in mono eyebrows/labels.
- No more than these 3 families visible at once.

---

## 4. Motion (locked)

| Token | Value | Use |
|---|---|---|
| `--ease-effortless` | `cubic-bezier(0.22, 1, 0.36, 1)` | Default. Smooth confident landing. |
| `--ease-snap` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | The gen-z bounce — hovers, tag-in, chips. Tasteful overshoot. |
| `--dur-quick` | `150ms` | Hover, focus. |
| `--dur-base` | `250ms` | Most transitions. |
| `--dur-slow` | `400ms` | Reveals, the tag-in handoff animation. |

- **Signature motion — "the tag-in":** when the demo hands off from bot→human, the
  incoming human bubble slides in with `--ease-snap` and the pistachio live-dot pulses
  once. This is the product's hero moment; animate it with love.
- **Effortless scroll reveals:** fade + 12px rise on `--ease-effortless`. No framer
  `whileInView` (same back-nav bug as adimoyal — use CSS + IntersectionObserver).
- **Banned:** stiff linear easing, slow >600ms UI transitions, spinner-heavy loading
  (use skeletons / the typing-dots).

---

## 5. Shape, depth, spacing

- **Radius:** friendly, not enterprise-sharp. `--r-sm: 8px` (buttons, inputs),
  `--r-md: 12px` (cards, chat bubbles), `--r-pill: 999px` (tags, the live badge).
  *(Krispy is rounded-friendly — the opposite of adimoyal's sharp editorial 4px.)*
- **Shadows — warm-tinted only.** `--shadow-soft: 0 8px 24px -10px rgba(60,40,20,.18)`,
  `--shadow-float: 0 20px 44px -20px rgba(60,40,20,.24)`. Warm brown tint, never cool
  grey. One elevation step; don't stack shadows.
- **Spacing:** 4px base. Generous air — the landing breathes (Resend/Linear density,
  not dashboard-cram).
- **Layout:** confident, slightly asymmetric where it earns it; content max ~1120px.

---

## 6. Components & signatures

- **CTA (primary):** solid `--gold`, `--ink` text (gold is light enough for dark text —
  higher contrast + friendlier than white-on-gold), `--r-sm`, Geist Mono label or
  Geist medium, hover → `--gold-hover` + a `--ease-snap` micro-lift.
- **CTA (secondary):** ghost — `--line` border, `--ink` text, transparent fill.
- **The install snippet** is a first-class component: mono, `--surface`/espresso card,
  a copy button, a little 🥐 or `$` prompt. It belongs *in the hero*.
- **Live badge:** pistachio dot + "Adi is live" / "human on" — the pistachio's home.
- **Chat bubbles:** visitor = `--butter` fill; bot = `--surface` with `--line`; human
  takeover = a subtle gold left-edge + the live dot. `--r-md`, warm.
- **Croissant mark 🥐** — the logo. A clean, single-color croissant (custom SVG, gold on
  cream / cream on espresso). Friendly, geometric-ish, not a clipart emoji in prod.
- **Code-as-hero:** real snippets on the landing, syntax-tinted, not screenshots.

### Banned components
- Drop-shadowed cold-white SaaS cards. Gradient-purple "AI" buttons. Emoji soup (the
  🥐 is *the* mark; beyond it, restraint). "Book a demo" bars. Cookie-wall theatrics.

---

## 7. Logo & wordmark (direction)

- **Wordmark:** "Krispy" (or "Krispy AI") — Fraunces or a lightly-customized geometric,
  warm, lowercase-friendly. Pair with the 🥐 croissant mark to its left.
- **Mark alone:** the croissant, usable as favicon / app icon / GitHub avatar — gold on
  cream (light) or cream on espresso (dark).
- Assets to generate (Nano Banana 2, on-brand): croissant logomark, OG/social card, a
  hero illustration (a croissant "tagging in" a chat bubble — the relay motif), favicon.
  Background-removed via green-screen prompt or the adimoyal toolkit bg-remover.

---

## 7.5 BOLD layer — Buttr the mascot & the gen-z / 2026 energy

Fresh Baked is the *system*; this is the *attitude*. Krispy must be unmistakable in a feed —
bold, a little chaotic, screenshot-bait. **Tasteful ≠ timid.** We go loud on purpose.

### Buttr — the mascot 🥐
Krispy has a character: **Buttr**, a croissant with a face and a vibe — effortlessly cool,
mildly unbothered, always "letting it cook." Buttr is the viral surface: reaction stickers,
loading states, 404s, Discord emotes, launch memes. Personality = says little, ships a lot;
the friend who's already handled it before you asked.
- **Expression set to generate:** chill/😎, cooking/👨‍🍳, waving, sleeping (idle), sparkle
  (success/live), shrug (error), mind-blown (launch). → stickers + OG variants + Discord emotes.
- **Style:** flat, bold, single-weight outline + solid fills — sticker-ready, NOT gradient-3D-mascot.

### Bold accents (extends §2 — spice, used loud but sparse)
| Token | Hex | Role |
|---|---|---|
| `--acid` | `#EEF23B` | Acid butter — the electric highlight. Big blocks, the "wow", social cards. |
| `--jam` | `#F0426B` | Hot jam — energy, hovers, Buttr's blush, launch chrome. |
`--gold` stays the workhorse; `--acid`/`--jam` are the loud cousins for hero blocks, sticker
fills, and section breaks. Pistachio `--fresh` is still *live-only*.

### Bolder type
Crank it. Hero Fraunces goes HUGE — `clamp(3.5rem, 12vw, 8rem)`, tight, lowercase, hand on the
tracking. Mix **mono contrast blocks**; a single oversized word can be a full-bleed screen
("cook."). Type is allowed to break the grid and be too big on purpose.

### Viral surfaces (design for the screenshot)
- **Hero is a scene, not a form** — Buttr + the live handoff happening, big.
- **Buttr sticker sheet** (in repo + Discord emotes).
- **Meme-template OG cards** ("me: paying Intercom $400/mo · Buttr: 🥐").
- **Cost "wall of shame"** — a slider of what you'd pay Intercom → a giant animated **$0**.
- Motion with attitude: `--ease-snap` bounce, hover reactions, a Buttr that blinks. Nothing static.

### Bold ≠ sloppy
Loud + confident, never ugly-for-ugly's-sake or unreadable. Contrast stays AA. Acid/jam are
*spice* — a whole page of acid is a headache, not a brand. Hero clarity still wins.

## 8. The "we don't do this" list

- Cold white / blue-grey enterprise palette.
- ALL-CAPS headlines; Inter as the display face.
- Neon or glowing anything.
- Spending pistachio on decoration (it means *live/worked* only).
- Stacked cold-grey shadows; sharp-corner enterprise cards.
- "Book a demo" / "Contact sales" energy anywhere.
- Emoji soup. Stock "AI robot" imagery. Gradient-purple AI clichés.
- framer-motion `whileInView` (back-nav blank bug).

---

## 9. Provenance

Derived from `brand-soul.md` (warm & open axis, bakery motif, Resend/Cal.com/Linear/
Supabase reference set) and the "Fresh Baked" direction set at founding. Firms up as the
landing + widget ship; update this doc when a new convention lands. Token/banned-list
changes are deliberate — they're the spine.
