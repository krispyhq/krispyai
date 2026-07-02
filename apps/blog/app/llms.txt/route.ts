import { getAllPosts, type Post } from "../../lib/posts";
import { BLOG_DESCRIPTION, BLOG_NAME, SITE_URL } from "../seo";

// Emitted at /llms.txt — the llmstxt.org convention: a plain-text map of the site for LLMs,
// so an assistant fetching the domain gets a curated overview + the best entry points instead
// of guessing from raw HTML. A route handler (not a static file) so every link is absolute
// and env-derived. force-static → prerendered at build alongside the pages.
export const dynamic = "force-static";

// A post is a comparison/howto by explicit frontmatter `type`, or (until `type` is set)
// by its tags. Keeps the roster right whether or not authors have adopted `type` yet.
function isKind(post: Post, kind: "comparison" | "howto"): boolean {
  return (
    post.type === kind || post.tags.some((t) => t.toLowerCase().replace(/[-\s]/g, "") === kind)
  );
}

function linkLine(post: Post): string {
  return `- [${post.title}](${SITE_URL}/${post.slug}): ${post.description}`;
}

export function GET(): Response {
  const posts = getAllPosts();
  const comparisons = posts.filter((p) => isKind(p, "comparison"));
  const howtos = posts.filter((p) => isKind(p, "howto"));

  const body = `# Krispy AI

> ${BLOG_DESCRIPTION}

Krispy AI is a free, open-source (MIT), self-hostable live-chat + AI support stack that runs
on Cloudflare's edge — AI replies, human handoff via Telegram, and a self-hosted knowledge
base, with no per-seat pricing and full ownership of your customer conversations.

## Audience

Solo founders, indie hackers, and small teams who want live chat and AI support they own and
self-host, without SaaS seat fees or vendor lock-in.

## Comparisons

${comparisons.map(linkLine).join("\n")}

## How-to

${howtos.map(linkLine).join("\n")}

## All posts

${posts.map(linkLine).join("\n")}

## More

- [${BLOG_NAME}](${SITE_URL}/): the full index.
- [RSS feed](${SITE_URL}/feed.xml)
`;

  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
