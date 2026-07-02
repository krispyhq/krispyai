import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { Analytics } from "@krispy/analytics";
import { pageMetadata } from "@krispy/seo";

const DESCRIPTION =
  "The flagship app in Builder's Stack — one shared design system (@krispy/ui), a Hono API, and Better Auth login, all wired end to end.";

// One door — pageMetadata() fills metadataBase, canonical, OG, twitter, and the
// `%s — Builder's Stack` title template from @krispy/config. No hand-rolled OG.
export const metadata: Metadata = pageMetadata({
  description: DESCRIPTION,
  tagline: "Web",
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Analytics>
          <header className="border-b border-border">
            <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
              <Link href="/" className="font-semibold">
                @krispy/web
              </Link>
              <div className="flex gap-4 text-sm text-muted-foreground">
                <Link href="/" className="hover:text-foreground">
                  Design system
                </Link>
                <Link href="/health" className="hover:text-foreground">
                  API health
                </Link>
                <Link href="/auth" className="hover:text-foreground">
                  Sign in
                </Link>
              </div>
            </nav>
          </header>
          <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
        </Analytics>
      </body>
    </html>
  );
}
