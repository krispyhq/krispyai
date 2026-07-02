# AGENTS.md — the primer for coding agents

Cross-tool guide for any AI coding agent working in this repo (Claude Code, Cursor, Codex, Copilot, Windsurf, …).
Codex, Cursor, and Copilot read a repo-root `AGENTS.md` by convention — **this file is the source of truth.** Claude Code also reads [`CLAUDE.md`](./CLAUDE.md); Cursor reads [`.cursor/rules.md`](./.cursor/rules.md). Both are short mirrors that point back here.

Read this **before writing code**. It tells you where everything lives so you don't reinvent what already exists.

---

## 1. The mental model — three buckets

This is a **bun-workspace monorepo** wrapped by **Nx** (task graph + enforced boundaries + generators). Every package has a role defined by _one question: is it served, and to whom?_

| Folder      | Role                                | Served?                          | Examples                                                                                                                      |
| ----------- | ----------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/`     | what **humans** see                 | public UI                        | `@krispy/web` (Next.js), `@krispy/landing` (marketing), `@krispy/mobile` (Expo/React Native)                                     |
| `services/` | what has a **URL** / its own deploy | served to other code             | `@krispy/api` (Hono + OpenAPI), `@krispy/payment` (Creem adapter), `@krispy/ai-worker` (background, no URL)                      |
| `libs/`     | **shared** code                     | **never served** — consumed only | `@krispy/ui`, `@krispy/auth`, `@krispy/db`, `@krispy/ai`, `@krispy/analytics`, `@krispy/email`, `@krispy/config`, `@krispy/api-types` |

If you're about to create a file, first decide which of these three it belongs to. If it doesn't obviously fit one, ask — don't invent a fourth top-level folder.

## 2. The map — all 14 packages

```
krispyai/
├── apps/
│   ├── web/          @krispy/web       Next.js App Router — renders @krispy/ui, live Better Auth login
│   ├── landing/      @krispy/landing   public marketing site (@krispy/ui hero + shared <Analytics/>)
│   └── mobile/       @krispy/mobile    real Expo / React Native starter rendering shared @krispy/ui tokens
├── services/
│   ├── api/          @krispy/api       Hono + OpenAPI (/health, /docs) — validates @krispy/api-types, mounts Better Auth
│   ├── payment/      @krispy/payment   Creem adapter + Mock provider + webhooks (/checkout)
│   └── ai-worker/    @krispy/ai-worker background load, NO URL (queue worker)
├── libs/
│   ├── ui/           @krispy/ui        shadcn components + tokens (web + RN) + Storybook
│   ├── auth/         @krispy/auth      Better Auth config (boot-verified end to end)
│   ├── db/           @krispy/db        Drizzle schema + client (the single ORM)
│   ├── ai/           @krispy/ai        provider-agnostic model client (Vercel AI SDK)
│   ├── analytics/    @krispy/analytics <Analytics/> provider + isomorphic typed event catalog (./events)
│   ├── email/        @krispy/email     Resend + React Email: typed, previewable templates + sendEmail()
│   ├── config/       @krispy/config    typed env: one Zod schema + cached getEnv()
│   └── api-types/    @krispy/api-types the shared API contract (Zod schemas + inferred types)
├── infra/            Dockerfiles, docker-compose, k8s (your deploy config)
├── scripts/          deploy.sh, tunnel.sh, seed.sh, link-env.sh
├── api-collection/   Bruno API collection (version-controlled requests)
├── agents/           the deep dive: skills, subagents, mcp.json (this file links there)
├── docs/             getting-started · costs · ai · architecture · nx · portless · analytics · email · secrets
├── .devops/Tiltfile  the runtime manifest — what boots and how
├── nx.json           task graph + boundary tags
└── tsconfig.base.json  shared compiler options (never fork)
```

## 3. The laws — do not break these

These are load-bearing. Nx turns the two headline laws into **lint errors** (every project is tagged `type:app` / `type:service` / `type:lib`; `@nx/enforce-module-boundaries` rejects violations), so breaking them fails `bunx nx run-many -t lint`.

1. **No upward import.** `libs` never import from `apps` or `services`. Dependencies point **down** only: `apps → services → libs`, never back up. If a lib needs something from an app, the abstraction is in the wrong place — lift it into the lib.
2. **One public door per lib.** Each lib exposes a single `src/index.ts`. Import by **package name** (`@krispy/db`), never a deep path (`@krispy/db/src/schema/users`). The barrel file is the contract.
3. **By feature, not by layer.** Inside an app/service, group by what it _does_ (`billing/`, `users/`), not by technical layer (`controllers/`, `models/`).
4. **One ORM: Drizzle.** All DB access goes through `@krispy/db`. No raw `pg`, no second ORM.
5. **Payments through the adapter.** Never call Creem (or any provider) directly from an app or the API — go through `@krispy/payment`. Swapping providers should touch one file, not fifty.
6. **Config, not hardcoding.** No hardcoded URLs, ports, or secrets. Read typed env through `@krispy/config`'s `getEnv()` (backed by `.env.local`, see `.env.example`). Portless injects ports — nothing is pinned.
7. **One tsconfig source of truth.** Every workspace's `tsconfig.json` extends the root `tsconfig.base.json`. Don't fork compiler options per package.
8. **SEO/GEO through `@krispy/seo` — enforced.** Every public page must export `metadata`/`generateMetadata` via `@krispy/seo`'s `pageMetadata()`, and public content must be server-rendered. `bun run check:seo` (in `bun run check`, lefthook pre-push, and CI) **fails the build** otherwise. Never hand-roll `Metadata`/OG/canonical or inline JSON-LD — see § 3.1 below.

### 3.1 SEO/GEO — the laws (enforced)

**`@krispy/seo` is the one door** for page metadata + JSON-LD. `bun run check:seo` gates it, so a public page that drifts can't merge. Source of truth: Google's guide — read it — <https://developers.google.com/search/docs/fundamentals/ai-optimization-guide>.

**DO**

- **Public content is server-rendered + crawlable** — never block JS/DOM/accessibility. A public page must not be a root `"use client"` component (push interactivity into a child component).
- Every public page uses **`pageMetadata()`** (title/description/canonical/OG/twitter, from `@krispy/config`).
- Content pages emit JSON-LD via `@krispy/seo` (`organizationJsonLd`, `websiteJsonLd`, `articleJsonLd`, `faqJsonLd`, `breadcrumbJsonLd` + `<JsonLd/>`) — for **rich results**, since structured data is optional for AI but valuable in classic Search.
- Semantic HTML; keep `sitemap.ts` current; spread `aiCrawlerRules()` into `robots.ts`.

**DON'T**

- Don't **chunk** content for AI, write in **"AI syntax"**, or mass-produce **recycled/scaled** content — the win is original, first-hand, expert content on crawlable pages.
- Don't treat **`llms.txt`** as a ranking lever — **Google Search ignores it** (kept only for non-Google engines).
- Don't hand-roll `Metadata`/OpenGraph/canonical or inline `<script type="application/ld+json">`.

**Private-route convention (exempt):** a route is private if any path segment (route-group parens stripped) is `app`, `dashboard`, `protected`, `auth`, or `internal`.

### 3.2 Compliance — enforced

The template ships the technical half of compliance as **gates that bite**, not docs that rot.

- **Accessibility is a lint gate.** Oxlint's `jsx-a11y` plugin runs at `correctness: error`, so an a11y violation (missing `alt`, click handler on a non-interactive element, …) **fails `bun run lint`** and CI. Fix it, or — only for a genuine false positive (e.g. an MDX element override that gets its text via `{...props}`) — suppress that one line with `// oxlint-disable-next-line jsx-a11y/<rule>` and a reason. Optional deeper axe-core runtime check: `scripts/check-a11y.ts` (a ready-to-enable stub).
- **Secrets are scanned in CI.** `gitleaks` (config `.gitleaks.toml`) fails the build on a committed secret. Never commit real keys — they go through Infisical / `.env.local` (git-ignored).
- **Dependencies are scanned.** `.github/dependabot.yml` (every workspace `package.json`) + an `osv-scanner` CI job. (Bun's binary lockfile limits OSV's JS coverage → Dependabot is primary; see `docs/soc2-readiness.md`.)
- **Analytics are consent-gated (GDPR).** `@krispy/analytics` does **not** initialize PostHog/Clarity until the user accepts `<ConsentBanner/>` — default off. Don't add a tracker that bypasses this.
- **Audit trail.** `securityEvent()` (`@krispy/analytics/events`) logs security events (sign-in wired in `libs/auth`); reuse it, don't hand-roll auth logging.
- **The docs are the source of truth:** [`docs/soc2-readiness.md`](./docs/soc2-readiness.md) (SOC 2 Trust Service Criteria map — what's wired vs what you owe) and [`docs/gdpr.md`](./docs/gdpr.md) (consent/privacy/data-rights + the legal checklist). Be honest with users: a template gives readiness, not a report.

## 4. How to run — Tilt (dev servers) + Nx (tasks)

Two tools, two jobs, no overlap: **Tilt = what's running; Nx = the task graph (build/typecheck/lint/test), caching, affected, boundaries, generators.** Dev servers are _never_ routed through Nx — you still `./tilt_up.sh`.

```bash
npm install -g portless   # one-time: stable named URLs for every served role
bun install
cp .env.example .env.local
./scripts/link-env.sh     # symlink root .env.local into each app/service (see §6)
./tilt_up.sh              # boots every app + service → dashboard at localhost:10380
```

- **Always `./tilt_up.sh`, never `tilt up` directly** — the script pins the Tilt UI to port **10380** so multiple Tilt projects coexist instead of fighting over the shared default. `./tilt_down.sh` stops it.
- **No pinned service ports.** Every served role runs behind [Portless](https://github.com/vercel-labs/portless) at a stable named URL — `<svc>.krispy.localhost:1355`:

  | Role      | URL                                                     |
  | --------- | ------------------------------------------------------- |
  | Web       | `http://web.krispy.localhost:1355`                       |
  | Landing   | `http://landing.krispy.localhost:1355`                   |
  | API       | `http://api.krispy.localhost:1355` (`/health` · `/docs`) |
  | Payment   | `http://payment.krispy.localhost:1355` (`/health`)       |
  | Storybook | `http://storybook.krispy.localhost:1355`                 |
  | AI Worker | background — no URL                                     |

- The **`.devops/Tiltfile` is the runtime source of truth**: it lists every resource, its `serve_cmd`, and its links. Adding a service = adding a `local_resource` there. See [`docs/portless.md`](./docs/portless.md).
- Single package during dev: `bun --filter @krispy/api dev`.
- Nx tasks: `bun run typecheck` · `bun run check` · `bun run build` · `bun run affected` (only what changed) · `bun run graph`. See [`docs/nx.md`](./docs/nx.md).
- Lint & format: **Oxlint + Oxfmt for speed; ESLint kept ONLY for the Nx module-boundary rule.** `bun run lint` (oxlint, whole repo) · `bun run format` / `format:check` (oxfmt) · `bun run lint:boundaries` (ESLint `@nx/enforce-module-boundaries`). See [`docs/linting.md`](./docs/linting.md).
- One-off flows are Tilt buttons (`db:push`, `deploy:staging`, `tunnel`) — `auto_init=False`, click to run.

## 5. Adding things — the decision

| You need…                         | Put it in                | Then                                                                                                                                     |
| --------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| shared code used in 2+ places     | a new `libs/*` package   | scaffold with the Nx generator: `nx g @nx/js:lib …` — it's born tagged `type:lib`, named `@krispy/*`, with its single `src/index.ts` door |
| something with its own URL/deploy | a new `services/*`       | scaffold, then add a `local_resource` to `.devops/Tiltfile`; skill: `agents/skills/add-a-service`                                        |
| a new user-facing surface         | a new `apps/*`           | scaffold, then wire it into `.devops/Tiltfile`                                                                                           |
| a new payment provider            | `@krispy/payment` adapter | never inline in an app; skill: `agents/skills/wire-a-new-payment-provider`                                                               |

Prefer the Nx generators — a generated package **can't be born breaking the boundary laws** (it's tagged and has its barrel from birth). Commands: [`docs/nx.md`](./docs/nx.md).

## 6. Env — one source, symlinked

There is **one** env file: root `.env.local` (copy from `.env.example`). Two ways it reaches processes:

- **`./tilt_up.sh`** sources root `.env.local` into every service automatically (the `.devops/Tiltfile` handles it).
- **Standalone `bun --filter @krispy/<x> dev`** — bun only loads `.env.local` from the _invoking_ directory, so run **`./scripts/link-env.sh`** once. It symlinks root `.env.local` into each app/service (`ln -sf ../../.env.local <pkg>/.env.local`), keeping one source of truth. The symlinks are gitignored.

**A fresh clone boots on an empty `.env.local`** — every paid integration is env-gated to a silent no-op (no key → the feature is off, the app still runs). Fill keys only when you actually want to send email / take payment / see analytics / call AI. Full turnkey guide: [`docs/getting-started.md`](./docs/getting-started.md) · what it costs: [`docs/costs.md`](./docs/costs.md).

## 7. Agent tooling — MCP

Copy [`agents/mcp.json`](./agents/mcp.json) → repo-root `.mcp.json` to give your agent: **context7** (up-to-date library docs), **postgres** (reads the live schema/data via `DATABASE_URL` — needs `uv` installed for `uvx`), **filesystem** (repo-scoped), **mobbin** (real app UI reference — paid plan). See [`docs/getting-started.md`](./docs/getting-started.md#agent-tooling) for setup.

### 7.1 Third-party skills / MCPs — vet before you install

A skill or MCP is **executable code running with your agent's permissions, plus a payload the model obeys** — treat it like a dependency you're about to `sudo`. It's the same caution that made us swap the SQL-injectable Postgres MCP for a read-only one. Before an unfamiliar one touches your agent, run the 5-step law:

1. **Scan** — `./scripts/scan-skill.sh <name>` (Clawdex). `malicious` → stop. `unknown` (most raw repos) → manual review + a code scanner, not a pass.
2. **Read the source** — the actual `SKILL.md` **and every bundled script/hook**, not the README. Reject prompt-injection/override language, non-official phone-home URLs, obfuscated/base64 instructions, "act without confirmation", or `curl | sh` installers.
3. **Check permissions** — inspect `allowed-tools` and any hooks (hooks auto-execute = highest risk). Reject broad grants + auto-installed hooks.
4. **Check provenance** — official (`anthropics/*`) / established firm > single-author brand-new repo. Mega-aggregator installer CLIs are untrusted by default. Confirm a real LICENSE.
5. **Prefer first-party; pin commits** — small enough? author it. When you vendor, pin a commit SHA, never a moving branch.

Full law + our curated, scan-gated recommended list (adapt / link-only / reject tiers): [`docs/agent-skills.md`](./docs/agent-skills.md). Scanner: [`scripts/scan-skill.sh`](./scripts/scan-skill.sh).

## 8. Before you finish

- `bunx nx run-many -t typecheck` passes (all 14).
- `bun run lint` (oxlint) clean and `bun run format:check` (oxfmt) clean.
- `bun run lint:boundaries` clean — no new upward import, no deep import past a lib's barrel.
- New service is in `.devops/Tiltfile`.
- New env var is in `.env.example` (with a safe local default, no real secret).
- Conventional-commit message (`feat:`, `fix:`, `docs:` …). See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## 9. Where to look next

- [`agents/subagents.md`](./agents/subagents.md) — specialized subagents (frontend, backend, db-migrations, reviewer) and when to spawn them.
- [`agents/skills/`](./agents/skills/) — step-by-step skills for the common structural tasks.
- [`agents/mcp.json`](./agents/mcp.json) — the MCP servers above.
- [`docs/architecture.md`](./docs/architecture.md) — the taxonomy and the two laws, with diagrams.
- [`docs/nx.md`](./docs/nx.md) — the task graph, caching, affected, boundaries, generators.
