# krispy docs 🥐

The Krispy AI documentation site — [Fumadocs](https://fumadocs.dev) (Next.js + MDX),
themed to the Krispy boulangerie palette (espresso · cream · gold · jam · pistachio, hard
offset shadows, mono uppercase micro-labels).

Content lives in [`content/docs`](./content/docs) as MDX. Everything is derived from the
actual code in `services/edge`, `packages/widget`, and `packages/cli` — no invented
features.

## Develop

This app is **standalone** — it keeps its own `bun.lock` and is intentionally **not** in
the root workspaces, so cloning the lean core doesn't pull Next/React into a core install.

```sh
cd apps/docs
bun install
bun run dev        # http://localhost:3000
```

## Build

```sh
bun run build      # fumadocs-mdx generates .source/, then next build --webpack (static export)
```

`fumadocs-mdx` runs on `postinstall` and on `dev`/`build`, regenerating the git-ignored
`.source/` directory from `content/docs`.

The default build explicitly uses Next's supported webpack mode for this MDX static
export. Type checking and static page generation remain enabled. The previous
Turbopack attempt did not complete within the local verification window.

### Dependency security

The standalone text lockfile is committed so the repository's recursive OSV scan
covers docs as well as the root workspace. Install with `bun install --frozen-lockfile`.
The narrow `overrides` in `package.json` pin patched versions of five existing
transitive dependency families (baseline-browser-mapping, nanoid, postcss,
source-map-js and zod); their parents' compatible ranges otherwise retained
vulnerable lockfile versions. These are fixed dependencies, not scan exclusions.
Review them during future upgrades and remove redundant pins only after the
resolved graph passes the same scan and docs build. Fumadocs is unchanged.

## Deploy

Target: **Cloudflare Pages**. `next.config.mjs` already uses `output: "export"`;
`bun run build` generates `out/`, including the static `/api/search` index.
Use the repository's reviewed deployment workflow; this app has no production Next.js server.

## Structure

| path                     | what                                                                   |
| ------------------------ | ---------------------------------------------------------------------- |
| `content/docs/*.mdx`     | the docs pages (Quickstart · Concepts · Guides · Reference · Security) |
| `content/docs/meta.json` | nav ordering (per folder)                                              |
| `source.config.ts`       | Fumadocs MDX source config                                             |
| `lib/source.ts`          | the content loader (served under `/docs`)                              |
| `app/global.css`         | the Krispy theme (palette + neo-brutalist chrome)                      |
| `app/layout.config.tsx`  | shared nav (title, links)                                              |
