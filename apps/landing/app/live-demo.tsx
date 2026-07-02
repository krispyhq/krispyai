"use client";

import { useEffect, useRef, useState } from "react";

type Line = {
  from: "bot" | "visitor" | "human";
  text: string;
  typingMs?: number; // show a typing indicator this long before the line appears
  afterMs?: number; // pause after this line before the next
};

// Scripted, no backend — the landing demo shows the handoff UX without a live operator
// (keeps it abuse-proof; the real Telegram loop is for self-hosters). Loops forever.
const SCRIPT: Line[] = [
  { from: "bot", text: "hey! 🥐 ask me anything — pricing, setup, whatever.", afterMs: 900 },
  { from: "visitor", text: "do you offer refunds?", afterMs: 500 },
  {
    from: "bot",
    text: "yep, 14 days no questions asked. want the link?",
    typingMs: 1100,
    afterMs: 900,
  },
  { from: "visitor", text: "actually can I talk to a human?", afterMs: 500 },
  { from: "bot", text: "one sec — tagging in a human 👇", typingMs: 900, afterMs: 700 },
  { from: "human", text: "hey! it's Sam 👋 what's up?", typingMs: 1400, afterMs: 2600 },
];

export function LiveDemo() {
  const [shown, setShown] = useState<Line[]>([]);
  const [typing, setTyping] = useState<Line["from"] | null>(null);
  const [humanLive, setHumanLive] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const wait = (ms: number) => new Promise<void>((r) => timers.push(setTimeout(r, ms)));

    async function run() {
      while (!cancelled) {
        setShown([]);
        setHumanLive(false);
        setTyping(null);
        await wait(600);
        for (const line of SCRIPT) {
          if (cancelled) return;
          if (line.typingMs) {
            setTyping(line.from);
            await wait(line.typingMs);
            if (cancelled) return;
            setTyping(null);
          }
          if (line.from === "human") setHumanLive(true);
          setShown((s) => [...s, line]);
          await wait(line.afterMs ?? 600);
        }
        await wait(1600);
      }
    }
    void run();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [shown, typing]);

  return (
    <div className="w-full max-w-sm overflow-hidden rounded-2xl border-2 border-espresso bg-card shadow-[8px_8px_0_0_var(--espresso)]">
      {/* header */}
      <div className="flex items-center gap-3 border-b-2 border-espresso bg-butter/60 px-4 py-3">
        <span className="grid size-9 place-items-center rounded-full border-2 border-espresso bg-gold text-lg">
          🥐
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[13px] font-bold">krispy</div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={`size-1.5 rounded-full transition-colors ${humanLive ? "bg-fresh" : "bg-muted-foreground/40"}`}
            />
            {humanLive ? "Sam is live" : "usually replies in seconds"}
          </div>
        </div>
      </div>

      {/* messages */}
      <div ref={scrollRef} className="flex h-72 flex-col gap-2 overflow-y-auto px-4 py-4">
        {shown.map((m, i) => (
          <Bubble key={i} from={m.from} text={m.text} />
        ))}
        {typing && <TypingDots from={typing} />}
      </div>

      {/* faux input */}
      <div className="flex items-center gap-2 border-t-2 border-espresso px-3 py-3">
        <div className="flex-1 rounded-full bg-muted px-4 py-2 text-sm text-muted-foreground">
          Message…
        </div>
        <button
          type="button"
          aria-label="Send message"
          className="grid size-9 place-items-center rounded-full border-2 border-espresso bg-gold text-primary-foreground"
        >
          ↑
        </button>
      </div>
    </div>
  );
}

function Bubble({ from, text }: { from: Line["from"]; text: string }) {
  const mine = from === "visitor";
  const isHuman = from === "human";
  return (
    <div
      className={`flex ${mine ? "justify-end" : "justify-start"} duration-300 animate-in fade-in slide-in-from-bottom-1`}
    >
      <div
        className={[
          "max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-snug",
          mine
            ? "bg-espresso text-cream"
            : isHuman
              ? "border-l-2 border-fresh bg-butter text-foreground"
              : "bg-muted text-foreground",
        ].join(" ")}
      >
        {isHuman && (
          <span className="mb-0.5 block font-mono text-[10px] uppercase tracking-wide text-fresh">
            human · live
          </span>
        )}
        {text}
      </div>
    </div>
  );
}

function TypingDots({ from }: { from: Line["from"] }) {
  return (
    <div className={`flex ${from === "visitor" ? "justify-end" : "justify-start"}`}>
      <div className="flex gap-1 rounded-2xl bg-muted px-3 py-2.5">
        {[0, 200, 400].map((d) => (
          <span
            key={d}
            className="size-1.5 animate-pulse rounded-full bg-muted-foreground/50"
            style={{ animationDelay: `${d}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
