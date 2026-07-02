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

const STEPS = [
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

const COMPARE: [string, boolean | string, boolean | string, boolean | string][] = [
  ["Open source (MIT)", true, false, "so-so"],
  ["Free to self-host", true, false, false],
  ["AI answers, built in", true, "paid add-on", "BYO"],
  ["Human handoff to your phone", true, "their app, paid", "so-so"],
  ["No per-seat tax", true, false, true],
  ["Own your data", true, false, true],
];

const FEATURES = [
  {
    e: "🤝",
    t: "human-in-the-loop",
    b: "The bot's the first touch, never the last word. Reply from Telegram; it shows up live in the chat.",
  },
  {
    e: "🔓",
    t: "open source, MIT",
    b: "Read every line, fork it, own it. The free alternative to Intercom & Crisp — forever.",
  },
  {
    e: "🆓",
    t: "free to self-host",
    b: "One command on Cloudflare's free tier. No API key, no server to babysit, no surprise invoice.",
  },
  {
    e: "🎙️",
    t: "answers in your voice",
    b: "One file is the bot's brain. It speaks as you, and won't make things up.",
  },
];

const POSTS = [
  [
    "krispy-vs-intercom",
    "Krispy vs Intercom",
    "The self-hosted, open alternative — and the honest cost math.",
  ],
  [
    "self-host-live-chat-cloudflare",
    "Self-host on Cloudflare, free",
    "Live chat on the free tier, no key, in one command.",
  ],
  [
    "how-we-built-live-takeover-durable-objects",
    "How live takeover works",
    "The Durable-Object trick behind bot→human, live.",
  ],
  ["why-open-source", "Why we made Krispy open source", "Trust by inspection, not by a badge."],
];

function Check({ v }: { v: boolean | string }) {
  if (v === true) return <span className="font-semibold text-fresh">✓</span>;
  if (v === false) return <span className="text-muted-foreground/50">—</span>;
  return <span className="text-xs text-muted-foreground">{v}</span>;
}

export default function Landing() {
  return (
    <div className="overflow-x-clip">
      {/* Nav */}
      <header className="sticky top-0 z-50 border-b border-border/70 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-2xl">🥐</span>
            <span className="font-display text-xl tracking-tight">krispy</span>
          </Link>
          <nav className="hidden items-center gap-7 font-mono text-[13px] text-muted-foreground md:flex">
            <a href="#how" className="transition-colors hover:text-foreground">
              how it works
            </a>
            <a href="#compare" className="transition-colors hover:text-foreground">
              vs intercom
            </a>
            <a href={BLOG_URL} className="transition-colors hover:text-foreground">
              blog
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <a href={GITHUB_URL}>★ Star</a>
            </Button>
            <Button asChild size="sm">
              <a href={CLOUD_URL}>Try Krispy Cloud</a>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-16 md:grid-cols-2 md:py-24">
        <div className="flex flex-col items-start gap-6">
          <span className="inline-flex items-center gap-2 rounded-full bg-butter px-3 py-1 font-mono text-xs uppercase tracking-wider text-crust">
            let the bot cook 🥐
          </span>
          <h1 className="font-display text-5xl leading-[0.95] tracking-tight sm:text-6xl lg:text-7xl">
            the ai answers.
            <br />
            <span className="text-gold">you tag in.</span>
          </h1>
          <p className="max-w-md text-lg text-muted-foreground">
            Krispy answers your visitors in your voice — and taps you in on Telegram the second a
            human's needed. Open source. Self-host in one command. No per-seat tax.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild size="lg">
              <a href={GITHUB_URL}>Self-host free →</a>
            </Button>
            <Button asChild variant="outline" size="lg">
              <a href="#demo">See the handoff</a>
            </Button>
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            MIT · runs on Cloudflare's free tier · no credit card
          </p>
        </div>
        <div id="demo" className="flex justify-center md:justify-end">
          <LiveDemo />
        </div>
      </section>

      {/* Cost band */}
      <section className="border-y border-border bg-muted/50">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-center gap-4 px-6 py-10 text-center sm:flex-row sm:gap-10">
          <p className="font-mono text-sm text-muted-foreground">
            paying <span className="text-foreground line-through">$100–400/mo</span> for a chat
            widget and a login your customers never asked for?
          </p>
          <p className="font-display text-4xl tracking-tight">
            krispy is <span className="text-fresh">$0</span>.
          </p>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="mx-auto max-w-6xl px-6 py-20">
        <div className="mb-14 flex flex-col items-center gap-3 text-center">
          <span className="font-mono text-xs uppercase tracking-wider text-crust">
            how it works
          </span>
          <h2 className="font-display text-4xl tracking-tight sm:text-5xl">
            a bot that knows when to get you
          </h2>
        </div>
        <div className="grid gap-8 md:grid-cols-3">
          {STEPS.map((s) => (
            <div
              key={s.n}
              className="group flex flex-col items-start gap-4 rounded-2xl border border-border bg-card p-7 transition-transform duration-300 hover:-translate-y-1"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.img} alt={s.title} className="size-24 object-contain" />
              <span className="font-mono text-sm text-gold">{s.n}</span>
              <h3 className="font-display text-2xl tracking-tight">{s.title}</h3>
              <p className="text-sm text-muted-foreground">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Comparison */}
      <section id="compare" className="border-y border-border bg-muted/40">
        <div className="mx-auto max-w-4xl px-6 py-20">
          <div className="mb-12 flex flex-col items-center gap-3 text-center">
            <span className="font-mono text-xs uppercase tracking-wider text-crust">
              the honest table
            </span>
            <h2 className="font-display text-4xl tracking-tight sm:text-5xl">
              krispy vs the usual
            </h2>
          </div>
          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="p-4 text-left font-mono text-xs uppercase tracking-wide text-muted-foreground">
                    <span className="sr-only">Feature</span>
                  </th>
                  <th className="p-4 text-center font-display text-lg text-gold">krispy 🥐</th>
                  <th className="p-4 text-center font-mono text-xs text-muted-foreground">
                    Intercom
                  </th>
                  <th className="p-4 text-center font-mono text-xs text-muted-foreground">
                    Chatwoot
                  </th>
                </tr>
              </thead>
              <tbody>
                {COMPARE.map((row, i) => (
                  <tr key={i} className="border-b border-border/60 last:border-0">
                    <td className="p-4 text-left text-foreground">{row[0] as string}</td>
                    <td className="p-4 text-center">
                      <Check v={row[1] as boolean} />
                    </td>
                    <td className="p-4 text-center">
                      <Check v={row[2] as boolean | string} />
                    </td>
                    <td className="p-4 text-center">
                      <Check v={row[3] as boolean | string} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-center font-mono text-xs text-muted-foreground">
            Intercom&apos;s great at what it is. It&apos;s just not built for a solo founder who
            wants to own their stack.
          </p>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="grid gap-5 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <div
              key={f.t}
              className="flex gap-4 rounded-2xl border border-border bg-card p-6 transition-colors hover:border-gold/60"
            >
              <span className="text-3xl">{f.e}</span>
              <div>
                <h3 className="font-display text-xl tracking-tight">{f.t}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{f.b}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Install */}
      <section className="mx-auto max-w-3xl px-6 py-12">
        <div className="rounded-2xl border border-border bg-espresso p-8 text-cream">
          <p className="mb-4 font-mono text-xs uppercase tracking-wider text-gold">
            self-host in one command
          </p>
          <pre className="overflow-x-auto font-mono text-sm leading-relaxed">
            <code>
              <span className="text-fresh">$</span> git clone{" "}
              {`https://github.com/lonormaly/krispyai`}
              {"\n"}
              <span className="text-fresh">$</span> cd krispyai && bun install
              {"\n"}
              <span className="text-fresh">$</span> bun run edge:deploy{" "}
              <span className="text-cream/50"># live on Cloudflare, free</span>
            </code>
          </pre>
        </div>
      </section>

      {/* Learn */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="mb-10 flex items-end justify-between">
          <h2 className="font-display text-3xl tracking-tight sm:text-4xl">learn the method</h2>
          <a
            href={BLOG_URL}
            className="font-mono text-sm text-muted-foreground hover:text-foreground"
          >
            all posts →
          </a>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {POSTS.map(([slug, title, blurb]) => (
            <a
              key={slug}
              href={`${BLOG_URL}/${slug}`}
              className="group flex flex-col gap-2 rounded-2xl border border-border bg-card p-5 transition-transform duration-300 hover:-translate-y-1"
            >
              <h3 className="font-display text-lg leading-tight tracking-tight group-hover:text-gold">
                {title}
              </h3>
              <p className="text-sm text-muted-foreground">{blurb}</p>
            </a>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section id="cloud" className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex flex-col items-center gap-6 rounded-3xl bg-espresso px-6 py-20 text-center text-cream">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 font-mono text-xs uppercase tracking-wider text-acid">
            let the bot cook 🥐
          </span>
          <h2 className="max-w-2xl font-display text-4xl leading-tight tracking-tight sm:text-6xl">
            ship a chat that actually gets you
          </h2>
          <p className="max-w-md text-cream/70">
            Self-host it free, or let us run it — Krispy Cloud, free tier, live in two minutes.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button
              asChild
              size="lg"
              className="bg-gold text-primary-foreground hover:bg-gold-hover"
            >
              <a href={GITHUB_URL}>Self-host free</a>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="border-cream/30 bg-transparent text-cream hover:bg-white/10"
            >
              <a href={CLOUD_URL}>Try Krispy Cloud</a>
            </Button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-10 text-sm text-muted-foreground sm:flex-row">
          <span className="flex items-center gap-2">
            <span className="text-lg">🥐</span> krispy — the ai answers, you tag in.
          </span>
          <div className="flex gap-6 font-mono text-xs">
            <a href={GITHUB_URL} className="hover:text-foreground">
              GitHub
            </a>
            <a href={BLOG_URL} className="hover:text-foreground">
              Blog
            </a>
            <Link href="/privacy" className="hover:text-foreground">
              Privacy
            </Link>
            <span>MIT</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
