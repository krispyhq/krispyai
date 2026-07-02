import type { Metadata } from "next";
import { Bricolage_Grotesque, Fraunces, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Analytics, ConsentBanner } from "@krispy/analytics";
import { JsonLd, organizationJsonLd, pageMetadata, websiteJsonLd } from "@krispy/seo";
import { SITE_URL } from "./seo";

// Fresh Baked type: Fraunces (warm display) · Bricolage Grotesque (characterful gen-z
// UI/body) · Geist Mono (receipts/labels/code). Exposed as CSS vars the @krispy/ui theme
// reads (--font-fraunces / --font-bricolage / --font-geist-mono).
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

const NAME = "Krispy AI";
const DESCRIPTION =
  "Open-source AI live chat with a human in the loop. The AI answers your visitors in your voice and hands off to you on Telegram the second a human's needed. Free to self-host. The open alternative to Intercom & Crisp.";

export const metadata: Metadata = pageMetadata({
  description: DESCRIPTION,
  tagline: "the ai answers · you tag in",
  ...({ icons: { icon: "/brand/favicon-mark.png" } } as object),
});

const structuredData = [
  organizationJsonLd({ name: NAME, url: SITE_URL }),
  websiteJsonLd({ name: NAME, url: SITE_URL, description: DESCRIPTION }),
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${bricolage.variable} ${geistMono.variable}`}>
      <body className="min-h-screen font-sans antialiased">
        <JsonLd data={structuredData} />
        <Analytics>{children}</Analytics>
        <ConsentBanner policyHref="/privacy" />
      </body>
    </html>
  );
}
