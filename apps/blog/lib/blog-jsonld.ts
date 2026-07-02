import type { JsonLdData } from "@krispy/seo";
import type { Post } from "./posts";

// Per-post structured data as a schema.org @graph (one <script> per post). Built here
// rather than via @krispy/seo's standalone builders because a post needs BlogPosting +
// publisher + conditional SoftwareApplication/HowTo nodes joined under one @graph — the
// shape Google's Rich Results Test reads for an article with breadcrumbs + FAQ.
//
// Grounded in Google's AI optimization guide: structured data isn't an AI-ranking hack,
// it earns RICH RESULTS in classic Search. AI citation comes from crawlable SSR content.

export interface FaqItem {
  question: string;
  answer: string;
}

/**
 * Parse the post's "## FAQ" section into Q/A pairs. Each "### Question" heading starts a
 * pair; the answer is the prose lines until the next "###" or "##" heading. Returns [] when
 * the post has no FAQ section (two posts don't) — the caller then omits the FAQPage node.
 */
export function parseFaq(content: string): FaqItem[] {
  const items: FaqItem[] = [];
  let inFaq = false;
  let question: string | null = null;
  let answer: string[] = [];

  const flush = () => {
    if (question) items.push({ question, answer: answer.join(" ").trim() });
    question = null;
    answer = [];
  };

  for (const line of content.split("\n")) {
    // "### x" fails /^##[ \t]/ (third char is "#", not whitespace), so h2 is h2-only.
    const h3 = /^###[ \t]+(.+)$/.exec(line);
    const h2 = h3 ? null : /^##[ \t]+(.+)$/.exec(line);

    if (h2) {
      flush();
      inFaq = (h2[1] ?? "").trim().toUpperCase() === "FAQ"; // any other h2 closes the FAQ
      continue;
    }
    if (!inFaq) continue;
    if (h3) {
      flush();
      question = (h3[1] ?? "").trim();
      continue;
    }
    if (question && line.trim()) answer.push(line.trim());
  }
  flush();
  return items;
}

/** "## " section headings (h2 only, FAQ excluded) — the step skeleton for a HowTo post. */
function sectionHeadings(content: string): string[] {
  return [...content.matchAll(/^##[ \t]+(.+)$/gm)]
    .map((m) => (m[1] ?? "").trim())
    .filter((h) => h && h.toUpperCase() !== "FAQ");
}

/**
 * The full @graph for one post: always BlogPosting + BreadcrumbList, plus FAQPage when the
 * post has an FAQ, plus SoftwareApplication (comparison) or HowTo (howto) by frontmatter
 * `type`. Absent `type` → BlogPosting + FAQPage, exactly the graceful default.
 */
export function postJsonLd(post: Post, siteUrl: string): JsonLdData {
  const url = `${siteUrl}/${post.slug}`;
  const image = `${siteUrl}/blog/${post.slug}-hero.png`;
  const publisher = {
    "@type": "Organization",
    name: "Krispy AI",
    logo: { "@type": "ImageObject", url: `${siteUrl}/opengraph-image` },
  };

  const graph: JsonLdData[] = [
    {
      "@type": "BlogPosting",
      headline: post.title,
      description: post.description,
      image,
      datePublished: post.date,
      dateModified: post.updatedAt,
      author: { "@type": "Person", name: post.author },
      publisher,
      mainEntityOfPage: url,
      url,
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: `${siteUrl}/` },
        { "@type": "ListItem", position: 2, name: "Blog", item: `${siteUrl}/` },
        { "@type": "ListItem", position: 3, name: post.title, item: url },
      ],
    },
  ];

  const faqs = parseFaq(post.content);
  if (faqs.length) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: faqs.map((f) => ({
        "@type": "Question",
        name: f.question,
        acceptedAnswer: { "@type": "Answer", text: f.answer },
      })),
    });
  }

  if (post.type === "comparison") {
    graph.push({
      "@type": "SoftwareApplication",
      name: "Krispy AI",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web, Cloudflare Workers",
      url: siteUrl,
      // Open-source & self-hostable — a real $0 offer, not a marketing zero.
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    });
  }

  if (post.type === "howto") {
    // ponytail: steps = the post's ## section headings. Refine to real HowToStep bodies
    // when the first genuine howto post ships and its steps warrant per-step text.
    const steps = sectionHeadings(post.content);
    graph.push({
      "@type": "HowTo",
      name: post.title,
      description: post.description,
      ...(steps.length
        ? {
            step: steps.map((s, i) => ({
              "@type": "HowToStep",
              position: i + 1,
              name: s,
              text: s,
            })),
          }
        : {}),
    });
  }

  return { "@context": "https://schema.org", "@graph": graph };
}

// ponytail self-check — run directly: `bun apps/blog/lib/blog-jsonld.ts`. Dormant during
// Next build (argv[1] is the build script, never this file). Synchronous (no TLA) so the
// module stays a plain ESM that Next can bundle into the server component graph.
if (process.argv[1]?.includes("blog-jsonld")) {
  const ok = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`self-check failed: ${msg}`);
  };
  const faqs = parseFaq(
    "intro\n## FAQ\n### Q1?\nA1 line one.\nA1 line two.\n### Q2?\nA2.\n## Other\nnope",
  );
  ok(faqs.length === 2, "two Q/A pairs");
  ok(faqs[0]?.answer === "A1 line one. A1 line two.", "multi-line answer joins");
  ok(faqs[1]?.question === "Q2?", "second question");
  ok(parseFaq("no faq here\n## Intro\ntext").length === 0, "no FAQ → empty");

  const post: Post = {
    slug: "krispy-vs-x",
    content: "## Intro\nhi\n## FAQ\n### Is it free?\nYes.",
    title: "Krispy vs X",
    description: "d",
    date: "2026-07-01",
    updatedAt: "2026-07-02",
    author: "The Krispy team",
    tags: ["comparison"],
    type: "comparison",
  };
  const typesOf = (p: Post) =>
    (postJsonLd(p, "https://blog.example.com")["@graph"] as JsonLdData[]).map((n) => n["@type"]);
  ok(
    JSON.stringify(typesOf(post)) ===
      JSON.stringify(["BlogPosting", "BreadcrumbList", "FAQPage", "SoftwareApplication"]),
    "comparison graph",
  );
  const { type: _omit, ...plain } = post;
  ok(
    JSON.stringify(typesOf(plain)) === JSON.stringify(["BlogPosting", "BreadcrumbList", "FAQPage"]),
    "default graph (no type)",
  );
  console.log("blog-jsonld self-check OK");
}
