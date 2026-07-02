import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Compile these workspace libs from TS/JSX source — no separate build step. This is
  // what makes `@krispy/ui` and `@krispy/analytics` (a "use client" provider) "just work".
  transpilePackages: ["@krispy/ui", "@krispy/analytics"],

  // Pin the workspace root to the repo. Without this, Next can guess the wrong root when
  // a stray lockfile exists higher up ($HOME), resolve a second React copy from there, and
  // crash prerendering with "Objects are not valid as a React child" (dual React).
  outputFileTracingRoot: path.join(import.meta.dirname, "..", ".."),

  // Linting is owned by oxlint + Nx boundaries (lefthook + CI), not `next lint`.
  // Skip Next's redundant build-time ESLint pass (it lacks the @next/next/* rule defs
  // this monorepo doesn't install, so it errors on our eslint-disable directives).
  // Mirrors apps/landing.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
