"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@krispy/ui";
import { signOut, useSession } from "../lib/auth-client";

const NAV = [
  { href: "/", label: "overview", n: "01" },
  { href: "/connect", label: "connect telegram", n: "02" },
  { href: "/knowledge", label: "knowledge base", n: "03" },
  { href: "/widget", label: "your widget", n: "04" },
  { href: "/billing", label: "billing", n: "05" },
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { data: session } = useSession();

  return (
    <div className="flex h-full flex-col gap-6 p-5">
      <Link href="/" onClick={onNavigate} className="flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/buttr-beret.webp"
          alt="Buttr, the Krispy croissant mascot"
          width={40}
          height={40}
          className="size-10 object-contain"
        />
        <span className="font-display text-2xl font-black tracking-tight">krispy</span>
      </Link>

      {/* Live badge — the pistachio's home (a human, ready to tag in). */}
      <div className="inline-flex w-fit items-center gap-2 rounded-full border-2 border-espresso bg-card px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-wider">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-fresh opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-fresh" />
        </span>
        you&apos;re on
      </div>

      <nav className="flex flex-1 flex-col gap-1.5">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={
                active
                  ? "flex items-center gap-3 rounded-md border-2 border-espresso bg-gold px-3 py-2.5 font-mono text-sm font-bold text-espresso shadow-[3px_3px_0_0_var(--espresso)]"
                  : "flex items-center gap-3 rounded-md border-2 border-transparent px-3 py-2.5 font-mono text-sm font-medium text-muted-foreground transition-colors hover:border-espresso/15 hover:text-espresso"
              }
            >
              <span className={active ? "text-espresso/60" : "text-crust"}>{item.n}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-col gap-3 border-t-2 border-espresso/10 pt-4">
        {session?.user && (
          <p
            className="truncate font-mono text-xs text-muted-foreground"
            title={session.user.email}
          >
            {session.user.name || session.user.email}
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => signOut()}
          className="w-full border-2 border-espresso bg-transparent font-mono text-espresso hover:bg-acid hover:text-espresso"
        >
          sign out
        </Button>
      </div>
    </div>
  );
}
