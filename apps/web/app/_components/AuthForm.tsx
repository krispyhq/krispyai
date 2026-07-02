"use client";

import { useState } from "react";
import { Button, Input, Label, AwningStripe } from "@krispy/ui";
import { signIn, signUp } from "../lib/auth-client";

type Mode = "sign-in" | "sign-up";

// The unauthenticated door. Branded (Fresh Baked, Buttr) sign-in / sign-up. On
// success the Better Auth session store updates and the gate swaps in the dashboard
// reactively — no redirect needed.
export function AuthForm() {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSignUp = mode === "sign-up";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const handlers = {
      onError: (ctx: { error: { message?: string } }) =>
        setError(ctx.error.message ?? "That didn't go through — mind trying again?"),
    };
    if (isSignUp) await signUp.email({ name, email, password }, handlers);
    else await signIn.email({ email, password }, handlers);
    setPending(false);
  }

  return (
    <main className="grid min-h-screen place-items-center bg-cream px-6 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/buttr-beret.webp"
            alt="Buttr, the Krispy croissant mascot"
            width={72}
            height={72}
            className="size-[72px] object-contain"
          />
          <span className="font-display text-3xl font-black tracking-tight">krispy</span>
          <p className="max-w-xs font-mono text-xs text-muted-foreground">
            {isSignUp
              ? "one account. your bot's already warming up. 🥐"
              : "welcome back — the bot missed you."}
          </p>
        </div>

        <div className="overflow-hidden rounded-[16px] border-2 border-espresso bg-card shadow-[8px_8px_0_0_var(--espresso)]">
          <AwningStripe />
          <form onSubmit={onSubmit} className="flex flex-col gap-4 p-7">
            <h1 className="font-display text-2xl font-black tracking-tight">
              {isSignUp ? "Create your Krispy" : "Sign in"}
            </h1>
            {isSignUp && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="name" className="font-mono text-xs uppercase tracking-wider">
                  Name
                </Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ada Lovelace"
                  required
                />
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="font-mono text-xs uppercase tracking-wider">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@bakery.dev"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="font-mono text-xs uppercase tracking-wider">
                Password
              </Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                minLength={8}
                required
              />
            </div>
            {error && (
              <p className="rounded-md border-2 border-destructive/40 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" variant="bold" size="lg" className="w-full" disabled={pending}>
              {pending ? "working…" : isSignUp ? "Create account →" : "Sign in →"}
            </Button>
            <button
              type="button"
              className="font-mono text-xs text-muted-foreground transition-colors hover:text-jam"
              onClick={() => {
                setError(null);
                setMode(isSignUp ? "sign-in" : "sign-up");
              }}
            >
              {isSignUp ? "already baking? sign in" : "new here? create an account"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
