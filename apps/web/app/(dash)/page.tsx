"use client";

import Link from "next/link";
import { Button, ButtrSays } from "@krispy/ui";
import { PageHeader } from "../_components/PageHeader";
import { useJson } from "../lib/use-json";
import { useSession } from "../lib/auth-client";
import { type BillingStatus, type UsageStatus, daysLeft, isUnlimited } from "../lib/types";

function firstName(nameOrEmail?: string): string {
  if (!nameOrEmail) return "friend";
  return nameOrEmail.split(/[@\s]/)[0] || "friend";
}

function PlanPill({ status, plan }: { status: string; plan: string }) {
  const map: Record<string, string> = {
    trialing: "bg-acid text-espresso",
    active: "bg-fresh text-espresso",
    past_due: "bg-jam text-cream",
    canceled: "bg-muted text-muted-foreground",
    none: "bg-muted text-muted-foreground",
  };
  const label = plan === "free" ? "self-host · free" : `cloud · ${status}`;
  return (
    <span
      className={`inline-flex items-center rounded-full border-2 border-espresso px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-wider ${map[status] ?? "bg-butter text-espresso"}`}
    >
      {label}
    </span>
  );
}

function UsageBar({ label, used, cap }: { label: string; used: number; cap: number | null }) {
  const unlimited = isUnlimited(cap);
  const capNum = cap ?? 0;
  const pct = unlimited || capNum === 0 ? 0 : Math.min(100, Math.round((used / capNum) * 100));
  const hot = pct >= 80;
  return (
    <div className="rounded-[14px] border-2 border-espresso bg-card p-5 shadow-[4px_4px_0_0_var(--espresso)]">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-crust">
          {label}
        </span>
        <span className="font-display text-2xl font-black tracking-tight">
          {used.toLocaleString()}
          <span className="font-mono text-sm font-medium text-muted-foreground">
            {unlimited ? " · unmetered" : ` / ${capNum.toLocaleString()}`}
          </span>
        </span>
      </div>
      {!unlimited && (
        <div className="mt-3 h-3 w-full overflow-hidden rounded-full border-2 border-espresso bg-cream">
          <div
            className={`h-full rounded-full ${hot ? "bg-jam" : "bg-gold"}`}
            style={{ width: `${Math.max(pct, 2)}%` }}
          />
        </div>
      )}
    </div>
  );
}

export default function Overview() {
  const { data: session } = useSession();
  const billing = useJson<BillingStatus>("/api/billing/status");
  const usage = useJson<UsageStatus>("/api/usage");

  const name = firstName(session?.user?.name || session?.user?.email);
  const b = billing.data;
  const u = usage.data;
  const trialDays = b?.status === "trialing" ? daysLeft(b.trialEndsAt) : null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="overview · le tableau"
        title={`bonjour, ${name}`}
        subtitle="here's your Krispy at a glance — plan, trial, and what the bot's been up to this month."
      />

      <ButtrSays img="/brand/buttr-chill.webp">
        {trialDays != null
          ? `you've got ${trialDays} day${trialDays === 1 ? "" : "s"} of trial left. plenty of time. i'm not going anywhere — i'm bread. 🥐`
          : "everything's warm and running. i'll ping your telegram the second a human's needed. 🥐"}
      </ButtrSays>

      {/* Plan / trial card */}
      <div className="rounded-[16px] border-2 border-espresso bg-card p-6 shadow-[6px_6px_0_0_var(--espresso)]">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-2">
            <span className="font-mono text-xs font-bold uppercase tracking-wider text-crust">
              your plan
            </span>
            {billing.loading ? (
              <span className="font-mono text-sm text-muted-foreground">checking…</span>
            ) : billing.error ? (
              <span className="font-mono text-sm text-destructive">
                billing offline — start the stack
              </span>
            ) : b ? (
              <div className="flex items-center gap-3">
                <span className="font-display text-3xl font-black tracking-tight">
                  {b.plan === "cloud" ? "Krispy Cloud" : "Self-host"}
                </span>
                <PlanPill status={b.status} plan={b.plan} />
              </div>
            ) : null}
            {trialDays != null && (
              <span className="font-mono text-xs text-muted-foreground">
                trial ends in {trialDays} day{trialDays === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <Button
            asChild
            variant="bold"
            className="shadow-[4px_4px_0_0_var(--espresso)] hover:shadow-[2px_2px_0_0_var(--espresso)]"
          >
            <Link href="/billing">
              {b?.plan === "cloud" ? "manage billing →" : "start free trial →"}
            </Link>
          </Button>
        </div>
      </div>

      {/* Usage */}
      <div className="flex flex-col gap-4">
        <h2 className="font-display text-2xl font-black tracking-tight">this month</h2>
        {usage.loading ? (
          <p className="font-mono text-sm text-muted-foreground">counting…</p>
        ) : usage.error ? (
          <p className="rounded-[14px] border-2 border-espresso bg-card p-5 font-mono text-sm text-muted-foreground shadow-[4px_4px_0_0_var(--espresso)]">
            usage is quiet — the edge service isn&apos;t reachable yet. start the stack to see live
            numbers.
          </p>
        ) : u ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <UsageBar label="ai answers" used={u.usage.ai} cap={u.limits.aiPerMonth} />
            <UsageBar
              label="human handoffs"
              used={u.usage.handoff}
              cap={u.limits.handoffPerMonth}
            />
          </div>
        ) : null}
      </div>

      {/* Quick links */}
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { href: "/connect", t: "connect telegram", b: "wire your bot + supergroup" },
          { href: "/knowledge", t: "teach the bot", b: "edit what it knows" },
          { href: "/widget", t: "grab your widget", b: "one script tag, done" },
        ].map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="group flex flex-col gap-1 rounded-[14px] border-2 border-espresso bg-card p-5 shadow-[4px_4px_0_0_var(--espresso)] transition-transform duration-300 ease-[var(--ease-quart)] hover:-translate-x-0.5 hover:-translate-y-0.5"
          >
            <span className="font-display text-lg font-bold tracking-tight group-hover:text-jam">
              {c.t}
            </span>
            <span className="text-sm text-muted-foreground">{c.b}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
