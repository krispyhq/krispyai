"use client";

import { useEffect, useState } from "react";
import { Button, ButtrSays } from "@krispy/ui";
import { PageHeader } from "../../_components/PageHeader";
import { useJson } from "../../lib/use-json";
import { saveTenant } from "../../lib/tenant";
import type { TenantConfigResponse } from "../../lib/types";

const PLACEHOLDER = `You are the friendly assistant for Baker's Dozen, a small-batch sourdough delivery in Tel Aviv.

Speak warmly and briefly, in the founder's voice. Facts you know:
- We deliver Tue/Thu/Sun, orders close 24h ahead.
- Sourdough loaf ₪38, focaccia ₪32. Cash or Bit on delivery.
- Delivery is free over ₪120, else ₪15.

If someone asks for a refund, a wholesale quote, or anything you're unsure about, don't guess — hand off to a human.`;

export default function Knowledge() {
  const { data, loading } = useJson<TenantConfigResponse>("/api/tenant");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "pending" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (data?.config?.systemPrompt != null) setPrompt(data.config.systemPrompt);
  }, [data]);

  async function onSave() {
    setSaving(true);
    setMsg(null);
    const res = await saveTenant({ systemPrompt: prompt });
    setSaving(false);
    if (res.ok) setMsg({ kind: "ok", text: "saved — the bot just learned all that. 🥐" });
    else if (res.pending)
      setMsg({
        kind: "pending",
        text: "saved locally — the edge write endpoint is still being wired (see setup notes).",
      });
    else setMsg({ kind: "err", text: res.error ?? "couldn't save — try again." });
  }

  const preview = (prompt.trim() || PLACEHOLDER).trim();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="brain · le savoir"
        title="knowledge base"
        subtitle="This one block is the bot's whole brain — who it is, what it knows, and when to tap you in. It answers from this, in your voice, and won't make things up."
      />

      <ButtrSays img="/brand/buttr-sparkle.webp">
        write it like you&apos;re briefing a new hire. the more you tell me, the less i guess. 🥐
      </ButtrSays>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Editor */}
        <div className="flex flex-col gap-3">
          <label
            htmlFor="kb"
            className="font-mono text-xs font-bold uppercase tracking-wider text-crust"
          >
            system prompt · knowledge
          </label>
          <textarea
            id="kb"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={PLACEHOLDER}
            spellCheck={false}
            className="h-80 w-full resize-y rounded-[12px] border-2 border-espresso bg-card p-4 font-mono text-sm leading-relaxed text-foreground shadow-[4px_4px_0_0_var(--espresso)] outline-none placeholder:text-muted-foreground/60 focus-visible:border-gold"
          />
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-muted-foreground">
              {prompt.length.toLocaleString()} chars
            </span>
            <Button
              onClick={onSave}
              variant="bold"
              disabled={saving || loading}
              className="shadow-[4px_4px_0_0_var(--espresso)] hover:shadow-[2px_2px_0_0_var(--espresso)]"
            >
              {saving ? "saving…" : "save knowledge →"}
            </Button>
          </div>
          {msg && (
            <p
              className={
                msg.kind === "ok"
                  ? "rounded-md border-2 border-fresh/50 bg-fresh/10 px-3 py-2 font-mono text-xs text-espresso"
                  : msg.kind === "pending"
                    ? "rounded-md border-2 border-crust/40 bg-butter/40 px-3 py-2 font-mono text-xs text-espresso"
                    : "rounded-md border-2 border-destructive/40 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive"
              }
            >
              {msg.text}
            </p>
          )}
        </div>

        {/* Live preview */}
        <div className="flex flex-col gap-3">
          <span className="font-mono text-xs font-bold uppercase tracking-wider text-crust">
            this is what your bot knows
          </span>
          <div className="flex-1 overflow-hidden rounded-[12px] border-2 border-espresso bg-espresso shadow-[4px_4px_0_0_var(--gold)]">
            <div className="flex items-center gap-2 border-b border-cream/15 px-4 py-2.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/buttr-beret.webp"
                alt=""
                aria-hidden
                className="size-6 object-contain"
              />
              <span className="font-mono text-xs font-bold uppercase tracking-wider text-acid">
                buttr&apos;s memory
              </span>
            </div>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-4 font-mono text-sm leading-relaxed text-cream/90">
              {preview}
            </pre>
          </div>
          {!prompt.trim() && (
            <p className="font-mono text-xs text-muted-foreground">
              showing a sample — start typing to make it yours.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
