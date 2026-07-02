import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Compile these workspace libs from TS/JSX source — no separate build step. This is
  // what makes `@krispy/ui` and `@krispy/analytics` (a "use client" provider) "just work".
  transpilePackages: ["@krispy/ui", "@krispy/analytics"],

  // Pin the workspace root to the repo so Next doesn't guess it from a stray lockfile
  // higher up (which resolves a second React copy and crashes prerendering).
  outputFileTracingRoot: path.join(import.meta.dirname, "..", ".."),
};

export default nextConfig;
