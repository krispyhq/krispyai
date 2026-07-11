# Secrets in krispyai

Never commit real secrets. Two kinds of config live in this repo's world:

- **The edge Worker's secrets** — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, `TENANT_SYNC_SECRET`. These live in **Cloudflare**, not in any file.
- **The `krispy` CLI's config** — `KRISPY_API`, `KRISPY_TENANT`, `TENANT_SYNC_SECRET`. Documented in `.env.example`; put your fill-ins in `.env.local` (git-ignored).

## 1. Worker secrets — `wrangler secret put`

The Worker never reads a `.env` file at runtime; set each secret in Cloudflare:

```bash
cd services/edge
bunx wrangler secret put TELEGRAM_BOT_TOKEN
bunx wrangler secret put TELEGRAM_CHAT_ID
bunx wrangler secret put TELEGRAM_WEBHOOK_SECRET
bunx wrangler secret put TENANT_SYNC_SECRET     # optional: gates /api/tenant/config
```

Local `wrangler dev` reads them from a git-ignored `.dev.vars` in `services/edge` if you want to iterate without deploying.

## 2. CLI config — `.env.local`

Copy `.env.example` → `.env.local`, fill it in. Keep it clean — **strip inline comments** (an unstripped comment can corrupt a value). Only `TENANT_SYNC_SECRET` is a real secret here, and it must match the Worker's.

## 3. Team + prod — [Infisical](https://infisical.com) is the source of truth

**Infisical (open-source secrets manager) is the single source of truth for every secret and for the Cloudflare deploy creds.** No secret ever lives in a committed file; every environment pulls from one place. `wrangler secret put` (§1) stays the _mechanism_ the Worker's runtime secrets reach Cloudflare — but the _value_ originates in Infisical, and the deploy path reads it from there, never from a hand-set field:

- **Worker runtime secrets** (`TELEGRAM_*`, `TENANT_SYNC_SECRET`, `BILLING_SYNC_SECRET`, …) sync to Cloudflare via the [native Cloudflare connector](https://infisical.com/docs/integrations/cloud/cloudflare-pages), so you never hand-copy a secret into the platform.
- **Deploy creds** (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) are fed from Infisical into a git-ignored `.env.local`, which [`deploy.sh`](../deploy.sh) sources (`set -a; . .env.local; set +a`) and [`scripts/cf-deploy-preflight.mjs`](../scripts/cf-deploy-preflight.mjs) asserts are present before any `wrangler deploy`. They are **never** committed and **never** placed in GitHub Actions — deploy is Tilt + wrangler, not CI.
- The API token needs: **Workers Scripts:Edit**, **Cloudflare Pages:Edit**, **Workers KV Storage:Edit** (Durable Objects are covered by Workers Scripts).

## Rules

- **Bindings are not secrets** (KV, Durable Objects) — they live in `wrangler.toml` / the Cloudflare project config, never in Infisical.
- One source of truth per environment; prefer the Infisical sync over per-platform `secret put` once you have more than one machine (hand-set `secret put` drifts).
