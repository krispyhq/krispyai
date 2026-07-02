"use client";

import { useState } from "react";
import { AwningStripe } from "@krispy/ui";
import { useSession } from "../lib/auth-client";
import { AuthForm } from "../_components/AuthForm";
import { Sidebar } from "../_components/Sidebar";

// The authenticated shell + gate. Signed out → the branded AuthForm. Signed in →
// the bold Krispy sidebar (fixed on desktop, a drawer on mobile) + the page.
export default function DashLayout({ children }: { children: React.ReactNode }) {
  const { data: session, isPending, error } = useSession();
  const [drawer, setDrawer] = useState(false);

  if (isPending) {
    return (
      <main className="grid min-h-screen place-items-center bg-cream">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/buttr-sparkle.webp"
          alt=""
          aria-hidden
          className="size-20 animate-pulse object-contain"
        />
      </main>
    );
  }

  // Auth API unreachable is a distinct, honest state (dev: start the stack).
  if (error && !session) {
    return (
      <main className="grid min-h-screen place-items-center bg-cream px-6">
        <div className="max-w-sm rounded-[16px] border-2 border-espresso bg-card p-7 text-center shadow-[8px_8px_0_0_var(--espresso)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/buttr-shrug.webp"
            alt=""
            aria-hidden
            className="mx-auto size-20 object-contain"
          />
          <p className="mt-3 font-display text-lg font-bold">can&apos;t reach the oven</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            the auth service is offline. start the stack with ./tilt_up.sh, then refresh.
          </p>
        </div>
      </main>
    );
  }

  if (!session) return <AuthForm />;

  return (
    <div className="min-h-screen bg-cream">
      {/* Mobile top bar */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b-2 border-espresso bg-cream/90 px-4 py-3 backdrop-blur-md md:hidden">
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/buttr-beret.webp" alt="" aria-hidden className="size-8 object-contain" />
          <span className="font-display text-xl font-black tracking-tight">krispy</span>
        </div>
        <button
          onClick={() => setDrawer((v) => !v)}
          aria-label="Toggle menu"
          className="rounded-md border-2 border-espresso px-3 py-1 font-mono text-sm font-bold"
        >
          {drawer ? "close" : "menu"}
        </button>
      </header>

      <div className="mx-auto flex max-w-7xl">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r-2 border-espresso bg-cream md:block">
          <Sidebar />
        </aside>

        {/* Mobile drawer */}
        {drawer && (
          <>
            <button
              aria-label="Close menu"
              className="fixed inset-0 z-40 bg-espresso/30 md:hidden"
              onClick={() => setDrawer(false)}
            />
            <aside className="fixed inset-y-0 left-0 z-50 w-64 border-r-2 border-espresso bg-cream md:hidden">
              <Sidebar onNavigate={() => setDrawer(false)} />
            </aside>
          </>
        )}

        <main className="min-w-0 flex-1">
          <AwningStripe className="hidden md:block" />
          <div className="mx-auto max-w-4xl px-6 py-10 md:px-10">{children}</div>
        </main>
      </div>
    </div>
  );
}
