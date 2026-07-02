"use client";

import { useEffect, useState } from "react";
import { Button, ButtrSays, Input, Label } from "@krispy/ui";
import { PageHeader } from "../../_components/PageHeader";
import { useJson } from "../../lib/use-json";
import { saveTenant } from "../../lib/tenant";
import type { TenantConfigResponse } from "../../lib/types";

const STEPS = [
  {
    n: "01",
    t: "make a bot with BotFather",
    b: "In Telegram, message @BotFather → /newbot. Name it, pick a username, and copy the token it hands back (looks like 123456:ABC-…). Paste it below.",
  },
  {
    n: "02",
    t: "create a supergroup with Topics on",
    b: "New Group → add your bot → upgrade to a supergroup, then Group Settings → turn ON Topics (Forum mode). Krispy opens one topic per visitor there.",
  },
  {
    n: "03",
    t: "make the bot an admin",
    b: "In the group, promote your bot to admin with 'Manage Topics' allowed — it needs that to open a topic per conversation.",
  },
  {
    n: "04",
    t: "grab the chat id",
    b: "Add @getidsbot (or @RawDataBot) to the group once; it prints the supergroup id — a negative number like -1001234567890. Copy it below, then remove that helper bot.",
  },
];

export default function Connect() {
  const { data, loading } = useJson<TenantConfigResponse>("/api/tenant");
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "pending" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (data?.config) {
      setBotToken(data.config.botToken ?? "");
      setChatId(data.config.chatId ?? "");
    }
  }, [data]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    const res = await saveTenant({ botToken: botToken.trim(), chatId: chatId.trim() });
    setSaving(false);
    if (res.ok) setMsg({ kind: "ok", text: "connected — the bot's wired to your telegram. 🥐" });
    else if (res.pending)
      setMsg({
        kind: "pending",
        text: "saved your details — the edge write endpoint is still being wired (see setup notes).",
      });
    else setMsg({ kind: "err", text: res.error ?? "couldn't save — try again." });
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="setup · branchez-vous"
        title="connect telegram"
        subtitle="Krispy hands off to you on Telegram. Wire it once — bot token + a supergroup with Topics — and you'll reply to visitors from your phone."
      />

      <ButtrSays img="/brand/buttr-cooking.webp">
        five minutes, tops. i&apos;ll open a topic per visitor so your DMs stay tidy. 🥐
      </ButtrSays>

      {/* Steps */}
      <div className="grid gap-4 sm:grid-cols-2">
        {STEPS.map((s) => (
          <div
            key={s.n}
            className="rounded-[14px] border-2 border-espresso bg-card p-5 shadow-[4px_4px_0_0_var(--espresso)]"
          >
            <span className="font-mono text-sm font-black text-crust">{s.n}</span>
            <h3 className="mt-1 font-display text-lg font-bold tracking-tight">{s.t}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{s.b}</p>
          </div>
        ))}
      </div>

      {/* Form */}
      <form
        onSubmit={onSave}
        className="flex flex-col gap-5 rounded-[16px] border-2 border-espresso bg-card p-6 shadow-[6px_6px_0_0_var(--espresso)]"
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="botToken" className="font-mono text-xs uppercase tracking-wider">
            bot token
          </Label>
          <Input
            id="botToken"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
            className="font-mono"
            autoComplete="off"
          />
          <p className="font-mono text-xs text-muted-foreground">
            from @BotFather. kept server-side.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="chatId" className="font-mono text-xs uppercase tracking-wider">
            supergroup chat id
          </Label>
          <Input
            id="chatId"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder="-1001234567890"
            className="font-mono"
            autoComplete="off"
          />
          <p className="font-mono text-xs text-muted-foreground">
            the negative id of your Topics-enabled supergroup.
          </p>
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

        <Button
          type="submit"
          variant="bold"
          size="lg"
          disabled={saving || loading}
          className="w-fit"
        >
          {saving ? "saving…" : "save connection →"}
        </Button>
      </form>
    </div>
  );
}
