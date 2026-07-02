"use client";

import { useState } from "react";
import { Button, ButtrSays } from "@krispy/ui";
import { PageHeader } from "../../_components/PageHeader";
import { useSession } from "../../lib/auth-client";

// Browser-visible edge origin — the widget POSTs here and loads widget.js from here.
const EDGE = process.env.NEXT_PUBLIC_EDGE_URL ?? "http://localhost:8787";

export default function WidgetPage() {
  const { data: session } = useSession();
  const [copied, setCopied] = useState(false);
  const tenant = session?.user?.id ?? "your-tenant-id";

  const snippet = `<script src="${EDGE}/widget.js"
        data-api="${EDGE}"
        data-tenant="${tenant}"
        data-title="Chat with us"
        async></script>`;

  async function copy() {
    await navigator.clipboard.writeText(snippet).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="embed · collez-moi"
        title="your widget"
        subtitle="One script tag, baked with your tenant id. Drop it before </body> on any page — the chat bubble shows up, and you tag in from Telegram."
      />

      <ButtrSays img="/brand/buttr-chill.webp">
        paste this once and forget it. i live in a shadow DOM, so your site&apos;s css can&apos;t
        mess with me and mine can&apos;t leak into yours. 🥐
      </ButtrSays>

      {/* Snippet — code-as-hero */}
      <div className="overflow-hidden rounded-[16px] border-2 border-espresso bg-espresso shadow-[6px_6px_0_0_var(--gold)]">
        <div className="flex items-center justify-between border-b border-cream/15 px-5 py-3">
          <span className="font-mono text-xs font-bold uppercase tracking-[0.2em] text-acid">
            paste before &lt;/body&gt;
          </span>
          <Button
            onClick={copy}
            size="sm"
            className="border-2 border-cream/40 bg-gold font-mono text-espresso hover:bg-gold-hover hover:text-espresso"
          >
            {copied ? "copied ✓" : "copy"}
          </Button>
        </div>
        <pre className="overflow-x-auto p-5 font-mono text-sm leading-relaxed text-cream/90">
          <code>{snippet}</code>
        </pre>
      </div>

      {/* Attributes */}
      <div className="rounded-[16px] border-2 border-espresso bg-card p-6 shadow-[4px_4px_0_0_var(--espresso)]">
        <h2 className="font-display text-xl font-bold tracking-tight">what each bit does</h2>
        <dl className="mt-4 flex flex-col divide-y divide-border">
          {[
            ["data-api", "your edge Worker — where the chat + live handoff run"],
            ["data-tenant", "your tenant id (baked in above) — routes chats to your Telegram"],
            ["data-title", "the header text on the chat panel — change it freely"],
            ["async", "loads without blocking your page"],
          ].map(([k, v]) => (
            <div key={k} className="flex flex-col gap-1 py-3 sm:flex-row sm:gap-6">
              <dt className="w-40 shrink-0 font-mono text-sm font-bold text-crust">{k}</dt>
              <dd className="text-sm text-muted-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="rounded-[14px] border-2 border-dashed border-espresso/40 bg-butter/30 p-5">
        <p className="font-mono text-xs leading-relaxed text-espresso/80">
          <span className="font-bold uppercase tracking-wider">live preview —</span> the widget
          mounts bottom-right on any page you paste it into. Once your Telegram is connected
          (Connect Telegram) and knowledge is set, send it a test message: the bot answers
          instantly, and a topic opens in your supergroup so you can tag in.
        </p>
      </div>
    </div>
  );
}
