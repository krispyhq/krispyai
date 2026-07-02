import type { ReactNode } from "react";
import Link from "next/link";
import { Button } from "@krispy/ui";
import { pageMetadata } from "@krispy/seo";
import { LiveDemo } from "./live-demo";

export const metadata = pageMetadata({
  description:
    "Open-source AI live chat with a human in the loop. The AI answers in your voice and hands off to you on Telegram the second a human's needed. Free to self-host — the open alternative to Intercom & Crisp.",
  tagline: "the ai answers · you tag in",
  path: "/",
});

const GITHUB_URL = process.env.NEXT_PUBLIC_GITHUB_URL ?? "https://github.com/lonormaly/krispyai";
const CLOUD_URL = process.env.NEXT_PUBLIC_CLOUD_URL ?? "#cloud";
const BLOG_URL = process.env.NEXT_PUBLIC_BLOG_URL ?? "http://blog.krispy.localhost:1355";

// Hard-offset bold card — kills the "1px border + soft shadow" ghost-card AI tell.
// Warm-tinted solid shadow (espresso is a warm near-black), one step, sticker-bold.
const BOLD = "border-2 border-espresso shadow-[6px_6px_0_0_var(--espresso)]";

type Step = { img: string; n: string; title: string; body: string };
const STEPS: Step[] = [
  {
    img: "/brand/buttr-cooking.png",
    n: "01",
    title: "the bot cooks",
    body: "Krispy answers your visitors instantly — in your voice, from a knowledge base you write. Not a generic 'how can I help you today' bot.",
  },
  {
    img: "/brand/buttr-chill.png",
    n: "02",
    title: "it knows when to tap out",
    body: "Refund edge case? Hot lead? A visitor who just wants a person? Krispy tags you in instead of flailing.",
  },
  {
    img: "/brand/buttr-sparkle.png",
    n: "03",
    title: "you tag in — from your phone",
    body: "The handoff pings your Telegram. You reply from wherever you are, and it lands live in the visitor's chat. No new dashboard.",
  },
];

type Cell = boolean | string;
type CompareRow = { label: string; krispy: Cell; intercom: Cell; chatwoot: Cell };
const COMPARE: CompareRow[] = [
  { label: "Open source (MIT)", krispy: true, intercom: false, chatwoot: "so-so" },
  { label: "Free to self-host", krispy: true, intercom: false, chatwoot: false },
  { label: "AI answers, built in", krispy: true, intercom: "paid add-on", chatwoot: "BYO" },
  {
    label: "Human handoff to your phone",
    krispy: true,
    intercom: "their app, paid",
    chatwoot: "so-so",
  },
  { label: "No per-seat tax", krispy: true, intercom: false, chatwoot: true },
  { label: "Own your data", krispy: true, intercom: false, chatwoot: true },
];

type Feature = { n: string; t: string; b: string };
const FEATURES: Feature[] = [
  {
    n: "01",
    t: "human-in-the-loop",
    b: "The bot's the first touch, never the last word. Reply from Telegram; it shows up live in the chat.",
  },
  {
    n: "02",
    t: "open source, MIT",
    b: "Read every line, fork it, own it. The free alternative to Intercom & Crisp — forever.",
  },
  {
    n: "03",
    t: "free to self-host",
    b: "One command on Cloudflare's free tier. No API key, no server to babysit, no surprise invoice.",
  },
  {
    n: "04",
    t: "answers in your voice",
    b: "One file is the bot's brain. It speaks as you, and won't make things up.",
  },
];

type Post = { slug: string; title: string; blurb: string };
const POSTS: Post[] = [
  {
    slug: "krispy-vs-intercom",
    title: "Krispy vs Intercom",
    blurb: "The self-hosted, open alternative — and the honest cost math.",
  },
  {
    slug: "self-host-live-chat-cloudflare",
    title: "Self-host on Cloudflare, free",
    blurb: "Live chat on the free tier, no key, in one command.",
  },
  {
    slug: "how-we-built-live-takeover-durable-objects",
    title: "How live takeover works",
    blurb: "The Durable-Object trick behind bot→human, live.",
  },
  {
    slug: "why-open-source",
    title: "Why we made Krispy open source",
    blurb: "Trust by inspection, not by a badge.",
  },
];

/** French-bakery awning: bold jam/cream diagonal stripes. Pure CSS — always renders,
 *  crisper than a PNG. Decorative, so hidden from a11y tree. */
function AwningStripe({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`h-3.5 w-full ${className}`}
      style={{
        backgroundImage:
          "repeating-linear-gradient(-45deg, var(--jam) 0 22px, var(--cream) 22px 44px)",
      }}
    />
  );
}

/** "FAIT MAISON" wax-stamp — rotated mono badge, ring border. */
function Stamp({ className = "" }: { className?: string }) {
  return (
    <div
      className={`grid size-28 -rotate-12 place-items-center rounded-full border-2 border-jam text-center text-jam ${className}`}
      style={{ boxShadow: "inset 0 0 0 2px var(--jam)" }}
    >
      <div className="font-mono text-[10px] font-bold uppercase leading-tight tracking-[0.18em]">
        fait
        <br />
        maison
        <br />
        <span className="text-[8px] tracking-[0.12em] opacity-70">· fresh daily ·</span>
      </div>
    </div>
  );
}

/** Buttr the mascot, narrating. A speech bubble in his voice — the personality thread
 *  that runs the whole scroll. `dark` flips the bubble for espresso rooms. */
function ButtrSays({
  img,
  children,
  dark = false,
  flip = false,
}: {
  img: string;
  children: ReactNode;
  dark?: boolean;
  flip?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 ${flip ? "flex-row-reverse" : ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={img} alt="Buttr the croissant mascot" className="size-20 shrink-0 object-contain" />
      <p
        className={`max-w-xs rounded-2xl border-2 border-espresso px-4 py-2.5 font-mono text-sm font-medium shadow-[4px_4px_0_0_var(--espresso)] ${
          dark ? "bg-cream text-espresso" : "bg-card text-foreground"
        }`}
      >
        {children}
      </p>
    </div>
  );
}

function Cell({ v }: { v: Cell }) {
  if (v === true) return <span className="text-lg font-black text-fresh">✓</span>;
  if (v === false) return <span className="text-espresso/25">—</span>;
  return <span className="font-mono text-[11px] text-muted-foreground">{v}</span>;
}

export default function Landing() {
  return (
    <div className="overflow-x-clip">
      {/* ── Nav ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b-2 border-espresso bg-cream/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/buttr-beret.png"
              alt="Buttr, the Krispy croissant mascot"
              className="size-9 object-contain"
            />
            <span className="font-display text-2xl font-black tracking-tight">krispy</span>
          </Link>
          <nav className="hidden items-center gap-7 font-mono text-[13px] font-medium text-muted-foreground md:flex">
            <a href="#how" className="transition-colors hover:text-jam">
              how it works
            </a>
            <a href="#compare" className="transition-colors hover:text-jam">
              vs intercom
            </a>
            <a href={BLOG_URL} className="transition-colors hover:text-jam">
              blog
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="hidden font-mono text-espresso hover:bg-acid hover:text-espresso sm:inline-flex"
            >
              <a href={GITHUB_URL}>★ Star</a>
            </Button>
            <Button
              asChild
              size="sm"
              className="border-2 border-espresso bg-gold font-mono font-semibold text-espresso shadow-[3px_3px_0_0_var(--espresso)] transition-transform hover:translate-x-px hover:translate-y-px hover:bg-gold hover:shadow-[1px_1px_0_0_var(--espresso)]"
            >
              <a href={CLOUD_URL}>Try Krispy Cloud</a>
            </Button>
          </div>
        </div>
      </header>

      <AwningStripe />

      {/* ── Hero ────────────────────────────────────────────── */}
      <section className="relative bg-cream">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-16 md:grid-cols-[1.1fr_0.9fr] md:py-24">
          <div className="flex flex-col items-start gap-6">
            <span
              className={`inline-flex items-center gap-2 rounded-full bg-acid px-3.5 py-1.5 font-mono text-xs font-bold uppercase tracking-wider text-espresso ${BOLD} shadow-[3px_3px_0_0_var(--espresso)]`}
            >
              let the bot cook · chaud devant 🥐
            </span>
            <h1 className="font-display font-black leading-[0.82] tracking-[-0.03em] text-balance text-[clamp(3.5rem,11vw,8rem)]">
              the ai
              <br />
              answers.
              <br />
              <span className="text-jam">you tag in.</span>
            </h1>
            <p className="max-w-md text-lg font-medium text-muted-foreground">
              Krispy answers your visitors in your voice — and taps you in on Telegram the second a
              human&apos;s needed. Open source. Self-host in one command. No per-seat tax.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                asChild
                size="lg"
                className={`bg-gold font-mono text-base font-semibold text-espresso transition-transform hover:translate-x-px hover:translate-y-px hover:bg-gold ${BOLD} hover:shadow-[3px_3px_0_0_var(--espresso)]`}
              >
                <a href={GITHUB_URL}>Self-host free →</a>
              </Button>
              <Button
                asChild
                variant="outline"
                size="lg"
                className="border-2 border-espresso bg-transparent font-mono text-base font-semibold text-espresso hover:bg-acid hover:text-espresso"
              >
                <a href="#demo">See the handoff</a>
              </Button>
            </div>
            <p className="font-mono text-xs font-medium text-muted-foreground">
              MIT · runs on Cloudflare&apos;s free tier · no credit card
            </p>
          </div>

          <div id="demo" className="relative flex justify-center md:justify-end">
            <Stamp className="absolute -left-4 -top-8 z-20 hidden bg-cream md:grid" />
            <div className="rotate-1 transition-transform duration-300 hover:rotate-0">
              <LiveDemo />
            </div>
          </div>
        </div>
      </section>

      {/* ── Buttr intro (the guide says bonjour) ────────────── */}
      <section className="bg-cream">
        <div className="mx-auto max-w-6xl px-6 pb-10">
          <ButtrSays img="/brand/buttr-beret.png">
            bonjour — i&apos;m Buttr. that&apos;s me answering up there. stick around, i&apos;ll
            show you how it works. 🥐
          </ButtrSays>
        </div>
      </section>

      {/* ── Cost band (ACID — loud) ─────────────────────────── */}
      <section className="border-y-2 border-espresso bg-acid">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-center gap-6 px-6 py-14 text-center sm:flex-row sm:gap-12 sm:text-left">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/buttr-chill.png"
            alt="Buttr the croissant, unbothered"
            className="size-28 shrink-0 object-contain"
          />
          <p className="max-w-md font-mono text-sm font-semibold text-espresso/80">
            paying{" "}
            <span className="text-espresso line-through decoration-jam decoration-2">
              $100–400/mo
            </span>{" "}
            for a chat widget and a login your customers never asked for?
          </p>
          <p className="font-display text-5xl font-black tracking-tight text-espresso sm:text-6xl">
            krispy is <span className="rounded-lg bg-espresso px-3 py-1 text-acid">$0</span>.
          </p>
        </div>
      </section>

      {/* ── How it works (ESPRESSO room) ────────────────────── */}
      <section id="how" className="bg-espresso text-cream">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="mb-14 flex flex-col items-start gap-3">
            <span className="font-mono text-xs font-bold uppercase tracking-[0.2em] text-acid">
              how it works · voilà
            </span>
            <h2 className="max-w-2xl font-display text-4xl font-black leading-[0.95] tracking-tight text-balance sm:text-6xl">
              a bot that knows when to get you
            </h2>
          </div>
          <div className="grid gap-8 md:grid-cols-3">
            {STEPS.map((s) => (
              <div
                key={s.n}
                className="group flex flex-col items-start gap-4 rounded-[14px] border-2 border-cream bg-espresso p-7 shadow-[6px_6px_0_0_var(--cream)] transition-transform duration-300 ease-[var(--ease-quart)] hover:-translate-x-0.5 hover:-translate-y-0.5"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.img} alt={s.title} className="size-24 object-contain" />
                <span className="font-mono text-3xl font-black text-acid">{s.n}</span>
                <h3 className="font-display text-2xl font-bold tracking-tight">{s.title}</h3>
                <p className="text-sm text-cream/70">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Comparison (cream) ──────────────────────────────── */}
      <section id="compare" className="bg-cream">
        <div className="mx-auto max-w-4xl px-6 py-20">
          <div className="mb-12 flex flex-col items-start gap-3">
            <span className="font-mono text-xs font-bold uppercase tracking-[0.2em] text-crust">
              the honest table
            </span>
            <h2 className="font-display text-4xl font-black tracking-tight sm:text-6xl">
              krispy vs the usual
            </h2>
          </div>
          <div className={`overflow-hidden rounded-[14px] bg-card ${BOLD}`}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-espresso bg-butter/50">
                  <th className="p-4 text-left">
                    <span className="sr-only">Feature</span>
                  </th>
                  <th className="p-4 text-center font-display text-lg font-black text-jam">
                    krispy 🥐
                  </th>
                  <th className="p-4 text-center font-mono text-xs font-medium text-muted-foreground">
                    Intercom
                  </th>
                  <th className="p-4 text-center font-mono text-xs font-medium text-muted-foreground">
                    Chatwoot
                  </th>
                </tr>
              </thead>
              <tbody>
                {COMPARE.map((row) => (
                  <tr key={row.label} className="border-b border-border last:border-0">
                    <td className="p-4 text-left font-medium text-foreground">{row.label}</td>
                    <td className="bg-acid/15 p-4 text-center">
                      <Cell v={row.krispy} />
                    </td>
                    <td className="p-4 text-center">
                      <Cell v={row.intercom} />
                    </td>
                    <td className="p-4 text-center">
                      <Cell v={row.chatwoot} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-8">
            <ButtrSays img="/brand/buttr-shrug.png">
              no shade — just facts. Intercom&apos;s great at being Intercom. i&apos;m just free,
              and i live on your box. 🥐
            </ButtrSays>
          </div>
        </div>
      </section>

      {/* ── Why Krispy (JAM room) ───────────────────────────── */}
      <section className="relative overflow-hidden border-y-2 border-espresso bg-jam text-cream">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/buttr-heart.png"
          alt=""
          aria-hidden
          className="pointer-events-none absolute -bottom-6 -right-6 size-44 rotate-6 object-contain opacity-90 md:size-56"
        />
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="mb-12 flex flex-col items-start gap-3">
            <span className="font-mono text-xs font-bold uppercase tracking-[0.2em] text-acid">
              why krispy
            </span>
            <h2 className="max-w-2xl font-display text-4xl font-black leading-[0.95] tracking-tight text-balance sm:text-6xl">
              the bot&apos;s the first touch, never the last word
            </h2>
          </div>
          <div className="grid max-w-3xl gap-x-10 gap-y-10 sm:grid-cols-2">
            {FEATURES.map((f) => (
              <div key={f.n} className="border-t-2 border-cream/40 pt-4">
                <span className="font-mono text-sm font-black text-acid">{f.n}</span>
                <h3 className="mt-1 font-display text-2xl font-bold tracking-tight">{f.t}</h3>
                <p className="mt-1 text-sm text-cream/80">{f.b}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Install (ESPRESSO room · cream receipt) ─────────── */}
      <section className="bg-espresso">
        <div className="mx-auto max-w-2xl px-6 py-20">
          <div className="mb-8">
            <ButtrSays img="/brand/buttr-chill.png" dark>
              took me 2 minutes to self-host. and i&apos;m a croissant. you&apos;ll be fine. 🥐
            </ButtrSays>
          </div>
          <div className={`overflow-hidden rounded-[14px] bg-card ${BOLD}`}>
            <AwningStripe />
            <div className="p-8">
              <div className="mb-5 flex items-center justify-between border-b border-dashed border-espresso/30 pb-4">
                <p className="font-mono text-xs font-bold uppercase tracking-[0.2em] text-crust">
                  self-host · fait maison
                </p>
                <span className="font-mono text-xs text-muted-foreground">no. 001</span>
              </div>
              <pre className="overflow-x-auto font-mono text-sm leading-relaxed text-foreground">
                <code>
                  <span className="text-fresh">$</span> git clone{" "}
                  {`https://github.com/lonormaly/krispyai`}
                  {"\n"}
                  <span className="text-fresh">$</span> cd krispyai && bun install
                  {"\n"}
                  <span className="text-fresh">$</span> bun run edge:deploy{" "}
                  <span className="text-muted-foreground"># live on Cloudflare, free</span>
                </code>
              </pre>
              <div className="mt-5 flex items-center justify-between border-t border-dashed border-espresso/30 pt-4 font-mono text-xs">
                <span className="uppercase tracking-[0.2em] text-crust">merci · total</span>
                <span className="text-lg font-black text-jam">$0.00</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Blog (cream) ────────────────────────────────────── */}
      <section className="relative overflow-hidden bg-cream">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/buttr-peek.png"
          alt=""
          aria-hidden
          className="pointer-events-none absolute left-0 bottom-4 hidden w-32 object-contain lg:block"
        />
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="mb-10 flex items-end justify-between">
            <h2 className="font-display text-3xl font-black tracking-tight sm:text-5xl">
              learn the method
            </h2>
            <a
              href={BLOG_URL}
              className="font-mono text-sm font-medium text-muted-foreground hover:text-jam"
            >
              all posts →
            </a>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {POSTS.map((p) => (
              <a
                key={p.slug}
                href={`${BLOG_URL}/${p.slug}`}
                className={`group flex flex-col gap-2 rounded-[14px] bg-card p-5 transition-transform duration-300 ease-[var(--ease-quart)] hover:-translate-x-0.5 hover:-translate-y-0.5 ${BOLD}`}
              >
                <h3 className="font-display text-lg font-bold leading-tight tracking-tight group-hover:text-jam">
                  {p.title}
                </h3>
                <p className="text-sm text-muted-foreground">{p.blurb}</p>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA (ESPRESSO closer) ─────────────────────── */}
      <section id="cloud" className="bg-cream px-6 pb-16">
        <div className="relative mx-auto flex max-w-6xl flex-col items-center gap-6 overflow-hidden rounded-[16px] border-2 border-espresso bg-espresso px-6 py-20 text-center text-cream shadow-[8px_8px_0_0_var(--jam)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/buttr-sparkle.png"
            alt=""
            aria-hidden
            className="pointer-events-none absolute -right-4 -top-4 size-28 rotate-12 object-contain opacity-90"
          />
          <span className="inline-flex items-center gap-2 rounded-full bg-acid px-3.5 py-1.5 font-mono text-xs font-bold uppercase tracking-wider text-espresso">
            let the bot cook 🥐
          </span>
          <h2 className="max-w-2xl font-display text-4xl font-black leading-[0.9] tracking-tight text-balance sm:text-7xl">
            ship a chat that actually gets you
          </h2>
          <p className="max-w-md font-medium text-cream/70">
            Self-host it free, or let us run it — Krispy Cloud, free tier, live in two minutes.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button
              asChild
              size="lg"
              className="border-2 border-espresso bg-acid font-mono text-base font-semibold text-espresso shadow-[4px_4px_0_0_var(--cream)] transition-transform hover:translate-x-px hover:translate-y-px hover:bg-acid hover:shadow-[2px_2px_0_0_var(--cream)]"
            >
              <a href={GITHUB_URL}>Self-host free</a>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="border-2 border-cream/40 bg-transparent font-mono text-base font-semibold text-cream hover:bg-white/10 hover:text-cream"
            >
              <a href={CLOUD_URL}>Try Krispy Cloud</a>
            </Button>
          </div>
        </div>
      </section>

      {/* ── Footer (Buttr waves goodbye) ────────────────────── */}
      <footer className="border-t-2 border-espresso bg-cream">
        <div className="mx-auto max-w-6xl px-6 py-12">
          <div className="mb-10 flex flex-col items-center gap-4 text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/buttr-wave.png"
              alt="Buttr waving goodbye"
              className="size-24 object-contain"
            />
            <p className="font-display text-2xl font-black tracking-tight">
              à bientôt — now go ship something.
            </p>
          </div>
          <div className="flex flex-col items-center justify-between gap-4 border-t border-border pt-6 text-sm text-muted-foreground sm:flex-row">
            <span className="font-medium">krispy — the ai answers, you tag in.</span>
            <div className="flex gap-6 font-mono text-xs">
              <a href={GITHUB_URL} className="hover:text-jam">
                GitHub
              </a>
              <a href={BLOG_URL} className="hover:text-jam">
                Blog
              </a>
              <Link href="/privacy" className="hover:text-jam">
                Privacy
              </Link>
              <span>MIT</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
