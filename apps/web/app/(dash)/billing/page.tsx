"use client";

import { useEffect, useState } from "react";
import { Button, ButtrSays } from "@krispy/ui";
import { PageHeader } from "../../_components/PageHeader";
import { useJson } from "../../lib/use-json";
import { type BillingStatus, daysLeft } from "../../lib/types";

const CLOUD_FEATURES = [
  "We host, scale & auto-update it — zero ops",
  "No terminal, no server to babysit",
  "One flat price — no per-seat tax, ever",
  "Cancel anytime, export your data",
];

const STATUS_COPY: Record<string, string> = {
  trialing: "You're on the free trial.",
  active: "You're subscribed — thanks for keeping the ovens on.",
  past_due: "Payment's overdue — update your card to stay live.",
  canceled: "Canceled — you keep access until the period ends.",
  none: "Not subscribed yet.",
};

export default function Billing() {
  const { data, loading, error, reload } = useJson<BillingStatus>("/api/billing/status");
  const [interval, setInterval] = useState<"monthly" | "annual">("monthly");
  const [busy, setBusy] = useState<null | "checkout" | "portal">(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [justPaid, setJustPaid] = useState(false);

  // Read the ?checkout=success return flag client-side (avoids a Suspense boundary),
  // then re-pull the (webhook-updated) status.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("checkout") === "success") {
      setJustPaid(true);
      reload();
    }
  }, [reload]);

  async function startCheckout() {
    setBusy("checkout");
    setActionError(null);
    const res = await fetch("/api/billing/checkout", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ interval }),
    })
      .then((r) => r.json())
      .catch(() => ({}));
    if (res.url) window.location.href = res.url;
    else {
      setBusy(null);
      setActionError(res.error ?? "Couldn't start checkout — is billing configured?");
    }
  }

  async function openPortal() {
    setBusy("portal");
    setActionError(null);
    const res = await fetch("/api/billing/portal", { method: "POST", credentials: "include" })
      .then((r) => r.json())
      .catch(() => ({}));
    if (res.url) window.location.href = res.url;
    else {
      setBusy(null);
      setActionError(res.error ?? "No billing account yet — start a plan first.");
    }
  }

  const isCloud = data?.plan === "cloud";
  const trialDays = data?.status === "trialing" ? daysLeft(data.trialEndsAt) : null;
  const periodEnd = data?.currentPeriodEnd
    ? new Date(data.currentPeriodEnd).toLocaleDateString()
    : null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="le menu · billing"
        title="billing"
        subtitle="Krispy Cloud is one flat price — no per-seat tax, cancel anytime. Or self-host it free, forever."
      />

      {justPaid && (
        <div className="rounded-[14px] border-2 border-fresh bg-fresh/10 px-5 py-4 font-mono text-sm text-espresso shadow-[4px_4px_0_0_var(--espresso)]">
          you&apos;re in — welcome to Krispy Cloud. 🥐 status updates once the payment clears.
        </div>
      )}

      <ButtrSays img="/brand/buttr-shrug.webp">
        cheaper than the coffee you dip me in. and no login your customers never asked for. 🥐
      </ButtrSays>

      {/* Current plan */}
      <div className="rounded-[16px] border-2 border-espresso bg-card p-6 shadow-[6px_6px_0_0_var(--espresso)]">
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-crust">
          current plan
        </span>
        {loading ? (
          <p className="mt-2 font-mono text-sm text-muted-foreground">checking…</p>
        ) : error ? (
          <p className="mt-2 font-mono text-sm text-destructive">
            billing service offline — start the stack to manage your plan.
          </p>
        ) : data ? (
          <div className="mt-2 flex flex-col gap-1">
            <span className="font-display text-3xl font-black tracking-tight">
              {isCloud ? "Krispy Cloud" : "Self-host · Free"}
            </span>
            <span className="font-mono text-sm text-muted-foreground">
              {STATUS_COPY[data.status] ?? data.status}
              {trialDays != null && ` ${trialDays} day${trialDays === 1 ? "" : "s"} left.`}
              {!trialDays && periodEnd && ` Renews / ends ${periodEnd}.`}
            </span>
          </div>
        ) : null}
      </div>

      {/* Upgrade / manage */}
      {isCloud && (data?.status === "active" || data?.status === "trialing") ? (
        <div className="rounded-[16px] border-2 border-espresso bg-card p-6 shadow-[4px_4px_0_0_var(--espresso)]">
          <h2 className="font-display text-xl font-bold tracking-tight">
            manage your subscription
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Update your card, see invoices, or cancel — all in the secure billing portal.
          </p>
          <Button
            onClick={openPortal}
            variant="bold"
            className="mt-5 shadow-[4px_4px_0_0_var(--espresso)] hover:shadow-[2px_2px_0_0_var(--espresso)]"
            disabled={busy === "portal"}
          >
            {busy === "portal" ? "opening…" : "manage billing →"}
          </Button>
        </div>
      ) : (
        <div className="relative overflow-hidden rounded-[16px] border-2 border-espresso bg-espresso p-7 text-cream shadow-[8px_8px_0_0_var(--gold)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/buttr-heart.webp"
            alt=""
            aria-hidden
            className="pointer-events-none absolute -bottom-4 -right-4 size-32 rotate-6 object-contain opacity-90"
          />
          <span className="font-mono text-xs font-bold uppercase tracking-[0.2em] text-acid">
            pour les gens occupés
          </span>
          <h2 className="mt-2 font-display text-3xl font-black tracking-tight">Krispy Cloud</h2>

          {/* interval toggle */}
          <div className="mt-4 inline-flex rounded-full border-2 border-cream/40 p-0.5 font-mono text-xs">
            {(["monthly", "annual"] as const).map((iv) => (
              <button
                key={iv}
                onClick={() => setInterval(iv)}
                className={
                  interval === iv
                    ? "rounded-full bg-gold px-4 py-1.5 font-bold text-espresso"
                    : "rounded-full px-4 py-1.5 text-cream/70"
                }
              >
                {iv === "monthly" ? "monthly" : "annual · 2mo free"}
              </button>
            ))}
          </div>

          <p className="mt-4 flex items-baseline gap-1">
            <span className="font-display text-6xl font-black text-gold">
              {interval === "monthly" ? "$19" : "$190"}
            </span>
            <span className="font-mono text-sm text-cream/70">
              {interval === "monthly" ? "/mo" : "/yr"}
            </span>
          </p>
          <p className="font-mono text-sm text-fresh">14-day free trial · no credit card</p>

          <ul className="mt-5 flex max-w-md flex-col gap-2 text-sm text-cream/90">
            {CLOUD_FEATURES.map((f) => (
              <li key={f} className="flex gap-2">
                <span className="font-black text-fresh">✓</span>
                {f}
              </li>
            ))}
          </ul>

          <Button
            onClick={startCheckout}
            size="lg"
            className="mt-6 border-2 border-cream bg-gold font-mono font-semibold text-espresso hover:translate-x-0.5 hover:translate-y-0.5 hover:bg-gold-hover hover:text-espresso"
            disabled={busy === "checkout"}
          >
            {busy === "checkout"
              ? "opening…"
              : data?.status === "trialing"
                ? "subscribe now →"
                : "start free trial →"}
          </Button>
          <p className="mt-3 font-mono text-xs text-cream/50">* launch pricing — may change.</p>
        </div>
      )}

      {actionError && (
        <p className="rounded-md border-2 border-destructive/40 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {actionError}
        </p>
      )}
    </div>
  );
}
