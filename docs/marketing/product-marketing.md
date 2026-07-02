# Krispy AI — Product Marketing (source of truth)

**Status:** Draft v1 (founding). This is the root marketing context every other
surface reads from — landing copy, README, launch posts, comparison pages, ads, emails.
Convention borrowed from `coreyhaines31/marketingskills`: **write this first, then every
copy task consumes it.** Companion to [`brand-soul.md`](../brand/brand-soul.md) (voice)
and [`design-lock.md`](../brand/design-lock.md) (visual).

---

## 1. One-sentence positioning

> **Krispy is open-source live chat with a human in the loop:** an AI answers your
> visitors in your voice, and hands off to *you* on Telegram the moment a person is
> needed. The free, self-hostable alternative to Intercom and Crisp.

## 2. Category & the "for who"

- **Category:** open-source AI live chat / customer conversation — *with human handoff*.
- **The "X for Y":** *the open-source live chat for people who'd rather not pay Intercom.*
- We are **claiming the honest-cost, own-your-data corner** of a category dominated by
  per-seat SaaS.

## 3. Audience & anti-personas

**Target (in priority):**
1. **Indie hackers & solo founders** — one person, a product or landing page, no support
   team, allergic to $X/seat SaaS.
2. **SMB owners & creators** (coaches, studios, small e-com, agencies) who close by
   conversation and want leads on their phone, not in a dashboard.
3. **Devs integrating chat for clients** — want an open widget they control, not a reseller seat.

**Anti-personas (we do NOT build for):**
- Enterprise support orgs optimizing *ticket deflection* (goal = talk to customers *less*).
- Buyers who want a managed vendor to own their data and don't care about lock-in.
- No-code users who won't touch a `<script>` tag or a deploy. (Hosted tier softens this later.)

## 4. The #1 frustration (verbatim language to mirror)

Capture and reuse the customer's own words:
- *"Intercom quoted me $X a seat — I'm one person."*
- *"I just want to talk to visitors without a $400/mo tool and a login they never asked for."*
- *"I don't want a chat widget that phones home / puts my customer data on someone else's servers."*
- *"The bot's fine for FAQs but I need it to actually get me when it matters."*

The frustration is **cost + lock-in + a bot that can't hand off.** Name it specifically;
never soften to "affordable" or "streamlined."

## 5. The villain

Per-seat SaaS pricing, vendor lock-in, and your conversations living on someone else's
servers. Also: the *dumb bot* that deflects instead of connecting. **Name the villain
honestly; never trash competitors childishly** — the HN/dev crowd punishes that. "Intercom
is great at what it is; it's just not built for a solo founder who wants to own their stack."

## 6. Messaging pillars (feature → benefit → outcome)

1. **Human-in-the-loop handoff.** Reply from Telegram where you already are → answer
   customers live without another dashboard → the bot knows when to tag you in.
2. **Open source (MIT).** Read every line, fork it, own it → the free alternative to
   Intercom/Crisp, forever → trust by inspection, not by badge.
3. **Free to self-host.** One command on Cloudflare's free tier, no API key → your data
   never leaves your box → no per-seat tax, no surprise invoice.
4. **Answers in your voice.** The AI speaks as *you*, from a knowledge base you edit →
   on-brand replies → not a generic "How can I help you today?" bot.

## 7. Proof points (use what's true; mark the rest [WIP])

- "Self-host in one command on Cloudflare's free tier."
- "The AI answers in the widget; a human reply pings *your* Telegram and shows up live."
- GitHub stars / contributors [WIP — grows post-launch].
- "Self-hosted by N teams" [WIP]. Public changelog. Real Discord screenshots [WIP].
- Honest cost math: paid stack ~$100–400+/mo → **$0 to self-host**.

## 8. Headline system (clarity in hero, croissant in chrome)

- **Eyebrow / kicker (playful):** `LET THE BOT COOK 🥐`
- **H1 (clear — states the mechanic):** *"The AI answers. You tag in."*
  - Alternates: "Live chat with a bot that knows when to tag you in." · "Chat that gets you when it's a human job."
- **Subhead (value + villain, does the real work):** *"Krispy answers your visitors in
  your voice and hands off to you on Telegram the second a human's needed. Open source.
  Self-host in one command. No per-seat tax."*
- **Primary CTA:** `Self-host Krispy` / `Star on GitHub` (never "Get Started").
- **Secondary CTA:** `See the handoff` (→ demo).

## 9. Competitive frame

| | Krispy | Intercom / Crisp | Chatwoot |
|---|---|---|---|
| Open source | ✅ MIT | ❌ | ✅ |
| Free to self-host | ✅ CF free tier, no key | ❌ | ⚠️ (run your own server) |
| AI answers, built in | ✅ free (CF Workers AI) | ⚠️ paid add-on | ⚠️ BYO |
| Human handoff to *your phone* | ✅ Telegram native | ✅ (their app, paid) | ⚠️ |
| Per-seat tax | ❌ none | ✅ $$/seat | ❌ (self-host) |

**Highest-ROI content bets** (from the field guide): the **Show HN narrative** ("got
tired of paying Intercom, built the open version") for the launch spike, and the
**`vs Intercom` / `vs Crisp` / `vs Chatwoot` comparison pages** for compounding AI-search
citations. Ship `/llms.txt` + FAQ/SoftwareApplication schema; never gate docs.

## 10. Launch spine (ORB, owned-first)

- **Owned** (funnel everything here): the docs site, a newsletter, a **Discord**, the repo.
- **Rented** (spikes → drive to owned): Show HN, Product Hunt, X threads, LinkedIn, r/selfhosted.
- **Borrowed:** co-market with an adjacent OSS tool; dev creators who'll star/share.
- Recruit founding members by hand; be present all launch day; convert every visitor to
  Discord/newsletter (rented traffic evaporates). Launches are recurring, not one-shot.

---

*Provenance: distilled from the `coreyhaines31/marketingskills` field guide (product-marketing,
launch, copywriting, ai-seo, community-marketing) + Krispy brand-soul. Update as we learn
real customer language and proof.*
