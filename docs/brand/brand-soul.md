# Krispy AI — Brand Soul

**Status:** Draft v1 (founding). This is the canonical doctrine for what Krispy *is*,
who it's for, and how it speaks — across the landing page, the docs, the widget's
default copy, the blog, and any future surface. Companion doc: `design-lock.md` (the
visual system). This doc is the *soul* (positioning + voice); that one is the *skin*.

---

## One-liner

> **The AI answers. You tag in.**
> Krispy is open-source live chat with a human in the loop — an AI that handles the
> easy questions in your voice, and hands off to *you* (on Telegram) the moment it
> matters. The warm, self-hostable alternative to Intercom and Crisp.

## The name

**Krispy** is a wink at **Crisp** — the closed widget many of us reach for and then
outgrow. We're the open one. It's also *fresh-baked*: warm, friendly, made-this-morning
— the opposite of cold enterprise support software. The mark is a croissant 🥐. It
should always feel like a small bakery, not a call center.

*(Trademark note: phonetically adjacent to "Krispy Kreme" — different industry, low
risk, conscious choice. `krispyai.com` is the home.)*

---

## The problem we solve

Every "talk to us" widget forces a bad trade:

- **A dumb bot** that frustrates people and answers nothing real, or
- **A $100–400/mo SaaS** (Intercom, Drift, Crisp) to get an actual human in the loop —
  with a login your customer never wanted, your data on someone else's servers, and a
  bill that scales faster than your revenue.

Krispy is the third option: **a bot that knows when to get out of the way.** It answers
what it can, and when a visitor needs a person, it pings *you* on a channel you already
have open — and your reply lands right back in the visitor's chat, live. Own the code,
own the data, pay nothing to start.

---

## What Krispy IS

- **Open-source first.** The whole product is public (open-core). You can read it,
  fork it, self-host it on Cloudflare's free tier in minutes. Trust is earned by being
  inspectable, not by a badge.
- **Human-in-the-loop by design.** The AI is the *first* touch, never the last word.
  The product's whole reason to exist is the graceful handoff to a real person. Tech
  serves the human; it doesn't replace them.
- **Channel-native.** You don't learn a new inbox. Krispy meets you where you already
  are — Telegram first, Slack next. Your phone is the dashboard.
- **Lean and self-hostable.** No server to run. Free AI (Cloudflare Workers AI, no key).
  A `<script>` tag and you're live.
- **Honest about what it is.** An AI answers your visitors. We say so. No "magic," no
  pretending a bot is a person behind their back.

## What Krispy is NOT

- **Not enterprise SaaS bloat.** No 14-seat pricing tiers, no "book a demo" wall, no
  onboarding call to send your first message. If it feels like Salesforce, it's wrong.
- **Not a soulless bot.** We are not selling "deflect 80% of tickets so you never talk
  to a customer." We're selling the opposite: *talk to more of them, more easily.*
- **Not lock-in.** No proprietary data format, no "export is a paid feature," no hostage
  situation. Leaving should be as easy as arriving.
- **Not hype-tech.** Even though it's AI, we never lead with "revolutionary,"
  "10x," "AGI," or model-name fetishism. AI is plumbing. The result — a real
  conversation — is the point.
- **Not a walled garden.** The hosted tier is a *convenience* (we run the infra for
  you), never the only way in. Self-host is always first-class.

---

## Audience

Primary, in priority order:
1. **Indie hackers & solo founders** shipping a product or a landing page who want a
   human touch without a support team or a support budget.
2. **SMB owners & creators** (coaches, studios, small e-commerce, agencies) who sell by
   conversation and close deals personally — they *want* to talk to leads, they just
   can't sit at a desk all day.
3. **Developers integrating chat** into a client site who'd rather drop in an
   open-source widget they control than resell someone's SaaS seat.

Aspirational tier (we should be *worthy* of them, not yet optimized for): small SaaS
teams who graduate from "founder answers everything" to "a couple of us tag in."

We are **not** optimizing for: large enterprise support orgs, ticket-deflection buyers,
or anyone whose goal is to talk to customers *less*.

---

## Positioning — the one axis

> **Warm and open, not cold and closed.**

Every judgment call — copy, color, a feature, a default — bends toward *warm,
human, own-it-yourself* and away from *corporate, impersonal, rented*. When unsure, ask:
does this feel like a note from a founder who cares, or a ticket in a queue? Choose the
founder.

**Reference axis:**
- **Closer to:** Resend, Cal.com, Linear, Plausible, Supabase — developer tools with
  taste, honesty, and a human voice. Plus a little bakery warmth on top.
- **Farther from:** Intercom, Zendesk, Drift, Salesforce — the register of enterprise
  support software. Also farther from cutesy no-code "AI chatbot!!" landing pages.

---

## Tone of voice

### Register
- **Plainspoken and warm.** Talk like a smart friend who ships, not a marketing team.
  Short sentences. Real words.
- **Builder-to-builder.** Assume the reader is capable. Show the code, name the
  tradeoff, respect their time.
- **A little playful.** The croissant, the Crisp wink, the "tag in" metaphor — Krispy
  has a sense of humor. Never zany, never emoji-soup, but never stiff either.
- **Honest over hype.** We say what it does and what it doesn't. Bad news plainly, no
  superlatives we can't back.

### Do / Don't

| | Do | Don't |
|---|---|---|
| **Headline** | "The AI answers. You tag in." | "Revolutionize customer engagement with AI 🚀" |
| **Subhead** | "Open-source live chat with a human in the loop. Free to self-host." | "The ultimate all-in-one AI-powered support platform." |
| **CTA** | "Clone it" / "Add to your site" / "See the demo" | "Book a demo" / "Talk to sales" |
| **Feature** | "Reply from Telegram. It shows up live in the chat." | "Omnichannel synergy for frictionless CX." |
| **Docs** | "Here's the 10-line version. Copy it." | "Please contact your account manager." |
| **Error/empty** | "Nothing here yet — send a message to try it." | "Oops! Something went wrong 😢" |

### Anti-patterns
- "Revolutionary," "game-changing," "10x," "unlock the power of."
- Emoji soup (the 🥐 is the brand mark; beyond that, restraint).
- "Book a demo" energy. If a solo dev can't go from zero to live without talking to us,
  we've failed.
- Pretending the bot is human. We're proud it's AI *and* proud it hands off.
- Enterprise throat-clearing ("In today's fast-paced digital landscape…").

---

## Values (the defaults these produce)

1. **Open by default** — public code, inspectable, forkable. Closed is the exception and
   must be justified.
2. **Own your data** — it lives in the user's Cloudflare account / their Telegram. We
   don't sit in the middle of conversations we don't have to.
3. **Human-in-the-loop** — the AI escalates *to* people; it never quietly replaces them.
4. **No lock-in** — easy in, easy out, no hostage features.
5. **Lean** — free to start, cheap to run, no infra to babysit. Complexity is a cost we
   pay only when a real user needs it.

---

## Success criteria

A page / feature / line of copy is on-brand if a thoughtful indie dev would:
1. Trust it (because they can read the code).
2. Get it live without talking to a human or hitting a paywall.
3. Feel it was made by someone who ships, not by a marketing department.
4. Smile once (the croissant, the wink) without being annoyed.
5. Never confuse it with Intercom.

If a change fails any of these, it's off-brand — even if it "converts better" in the
short term.

---

## Provenance & change process

- Born from the adimoyal HelpChat pattern + the `crisp-cf-ai-chat-starter` demo, then
  generalized into a standalone open-core product.
- **Voice + positioning changes** require a deliberate call (this is the spine).
- **Examples/phrasing** can be added freely as we ship more surfaces.
- Keep `design-lock.md` in sync when the visual system firms up.
