import type { Metadata } from "next";
import { Bricolage_Grotesque, Fraunces, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Analytics } from "@krispy/analytics";
import { pageMetadata } from "@krispy/seo";

// Fresh Baked type (mirrors apps/landing): Fraunces (warm display) · Bricolage
// Grotesque (characterful UI/body) · Geist Mono (receipts/labels/code). Exposed as
// the CSS vars the @krispy/ui theme reads (--font-fraunces / --font-bricolage /
// --font-geist-mono).
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
  weight: ["400", "500", "600", "700", "900"],
});
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
});
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = pageMetadata({
  title: "Dashboard",
  description:
    "Your Krispy Cloud dashboard — connect Telegram, edit what your bot knows, grab your widget, and manage billing. The ai answers, you tag in.",
  tagline: "your krispy",
  ...({ icons: { icon: "/brand/favicon-mark.png" } } as object),
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${bricolage.variable} ${geistMono.variable}`}>
      <body className="min-h-screen bg-cream font-sans text-foreground antialiased">
        <Analytics>{children}</Analytics>
      </body>
    </html>
  );
}
