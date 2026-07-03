# Make it yours

**The structure is the product. The packages are worked examples you gut.**

Everything under `apps/`, `services/`, and `libs/` is a demonstration that the pattern holds end to end — real auth, real payments, real AI, real email, all wired the right way. You keep the three folders and the three laws (`no-upward-import` · `one-public-door` · `by-feature-not-layer`); you **delete** the examples you don't need and rename the scope to your company. What's left is a repo shaped correctly with only your code in it.

This guide is the clean-deletion checklist for the three biggest examples, plus the `@krispy/*` → `@yourco/*` rename. The pattern generalizes: every package leaves a trail in the same handful of places.

## The five places a package leaves a trail

Deleting a package cleanly means removing its footprint from each of these. Learn the list once and every deletion is mechanical:

1. **The directory** — `rm -rf apps/mobile` (etc).
2. **`.devops/Tiltfile`** — the served roles each have a `local_resource(...)` block. (Libs and Expo apps have none.)
3. **`.env.example`** — the keys that integration reads.
4. **`.mcp.json` / deps** — any MCP server or dependency only that package used.
5. **`tsconfig.base.json` `paths`** — the `@krispy/<name>` mapping (this is what gives the Nx boundary rule its teeth; a stale entry is harmless but dishonest).

Then `bun install` to prune the lockfile, and `bunx nx run-many -t typecheck` to prove nothing dangled.

---

## Delete `apps/mobile` (the Expo/React Native example)

The simplest — mobile has **no Tilt resource** (Expo runs its own dev server) and no env keys of its own.

1. `rm -rf apps/mobile`
2. `.devops/Tiltfile` — nothing (mobile was never in it).
3. `tsconfig.base.json` — remove the `"@krispy/mobile": [...]` line from `paths`.
4. `package.json` — the `overrides` block pinning `@types/react` to `~19.0.x` **exists only for mobile** (React Native 0.79's bundled JSX types reject `@types/react` 19.2.x; read the `$comment`). With mobile gone you can drop the `overrides` block and its `$comment`, letting web/ui float to `^19`. Optional — leaving the pin does no harm.
5. `bun install` → `bunx nx run-many -t typecheck`.

---

## Delete `services/payment` (the Creem / Merchant-of-Record example)

A served service, so it has the full footprint.

1. `rm -rf services/payment infra/payment.Dockerfile api-collection/payment`
2. **`.devops/Tiltfile`** — delete the entire `local_resource('payment', …)` block (the one with `payment.stack` + the `/health` link).
3. **`.env.example`** — remove `CREEM_API_KEY` and `CREEM_WEBHOOK_SECRET` (and their comment block).
4. **`infra/docker-compose.yml`** — remove the `payment:` service under `--profile app`.
5. **`scripts/deploy.sh`** — drop `payment` from the `SERVICES=(api ai-worker payment)` array.
6. **`api-collection/environments/local.bru`** — remove any `payment`-scoped variables.
7. **`tsconfig.base.json`** — remove the `"@krispy/payment": [...]` line.
8. Grep for stragglers: `grep -rn "payment\|CREEM" --exclude-dir=node_modules .` — clean up README/docs mentions.
9. `bun install` → `bunx nx run-many -t typecheck`.

No other package imports `@krispy/payment` (it's a standalone service), so nothing downstream breaks.

---

## Delete `libs/ai` (the model-provider example)

A lib — **no Tilt resource of its own** — but it has **consumers**, so this is the one deletion with a downstream. `@krispy/ai` is imported by:

- `services/ai-worker` (the whole point of the worker).

  (The marketing site's `apps/landing/app/llms.ts` also imported it, but landing moved to the [`krispy-site`](https://github.com/lonormaly/krispy-site) repo — handle that consumer there.)

So "delete `libs/ai`" really means "delete `libs/ai` **and** the code that consumes it." Decide first: are you dropping AI entirely, or swapping the provider? If swapping, keep `libs/ai` and edit `libs/ai/src/providers.ts` instead — don't delete.

To drop AI entirely:

1. `rm -rf libs/ai`
2. `rm -rf services/ai-worker infra/ai-worker.Dockerfile` — the worker exists to run AI jobs; without `@krispy/ai` it has no purpose.
3. **`.devops/Tiltfile`** — delete the `local_resource('ai-worker', …)` block.
4. **`.env.example`** — remove `AI_API_KEY` (and its comment block).
5. **`infra/docker-compose.yml`** — remove the `ai-worker:` service (and the `redis:` service if nothing else uses the queue).
6. **`scripts/deploy.sh`** — drop `ai-worker` from the `SERVICES` array.
7. *(marketing site, in the `krispy-site` repo)* **`apps/landing/app/llms.ts`** — remove the `@krispy/ai` import / usage there.
8. **`.mcp.json`** — no AI-specific server ships (context7/postgres/filesystem/mobbin are unrelated); nothing to remove.
9. **`tsconfig.base.json`** — remove the `"@krispy/ai"` **and** `"@krispy/ai-worker"` lines.
10. `bun install` → `bunx nx run-many -t typecheck`.

---

## Rename `@krispy/*` → `@yourco/*`

`@stack` is a placeholder scope. Make it yours in one sweep:

1. **Package names** — the `"name"` field in every `apps/*`, `services/*`, `libs/*` `package.json`.
2. **`tsconfig.base.json` `paths`** — the keys (`"@krispy/db"` → `"@yourco/db"`).
3. **Every import** — `from "@krispy/…"` across all source.
4. **`.devops/Tiltfile`** — the `bun --filter @krispy/<x>` targets.
5. **Docs** — README, `docs/*`, `AGENTS.md`, `CLAUDE.md`.

A single sweep covers all of it (macOS `sed`; on Linux use `sed -i`):

```bash
grep -rl "@krispy/" --exclude-dir=node_modules --exclude-dir=.git . \
  | xargs sed -i '' 's/@stack\//@yourco\//g'
bun install
bunx nx run-many -t typecheck   # prove the rename is total
```

Because every lib has **one public door** and is imported **by package name** (never a deep path), the rename is a flat find-and-replace — there are no scattered internal paths to chase. That's the boundary thesis paying off: a clean seam is a cheap rename.
