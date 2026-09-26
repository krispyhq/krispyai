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
                                                # (also the server-to-server credential
                                                # accepted on /api/operator/*)
```

Related but NOT a secret: `API_ORIGIN` (the cloud API origin that verifies operator
bearer tokens via `GET /me` — e.g. `https://api.krispyai.com`). It's a plain var in
`wrangler.toml` per env; unset means operator bearer auth **fails closed** (a
self-host without the operator app doesn't need it).

The hosted preview Worker is paired with the dev cloud API at
`https://api-preview.krispyai.com`; this value is committed in
`services/edge/wrangler.toml` under `[env.preview.vars]`. Production keeps its separate
`https://api.krispyai.com` verifier. Keep these origins and their Infisical environments
paired; never point the preview Worker at the production API.

Local `wrangler dev` reads them from a git-ignored `.dev.vars` in `services/edge` if you want to iterate without deploying.

## 2. CLI config — `.env.local`

Copy `.env.example` → `.env.local`, fill it in. Keep it clean — **strip inline comments** (an unstripped comment can corrupt a value). Only `TENANT_SYNC_SECRET` is a real secret here, and it must match the Worker's.

## 3. Team + prod — [Infisical](https://infisical.com) is the source of truth

**Infisical (open-source secrets manager) is the single source of truth for every secret and for the Cloudflare deploy creds.** No secret ever lives in a committed file; every environment pulls from one place. `wrangler secret put` (§1) stays the _mechanism_ the Worker's runtime secrets reach Cloudflare — but the _value_ originates in Infisical, and the deploy path reads it from there, never from a hand-set field:

- **Worker runtime secrets** (`TELEGRAM_*`, `TENANT_SYNC_SECRET`, `BILLING_SYNC_SECRET`, …) sync to Cloudflare via the [native Cloudflare connector](https://infisical.com/docs/integrations/cloud/cloudflare-pages), so you never hand-copy a secret into the platform.
- **Optional gateway configuration** (`KNOWLEDGE_GATEWAY_URL`, `KNOWLEDGE_TENANT_ID`, `KNOWLEDGE_SITE_ID`, `KNOWLEDGE_TIMEOUT_MS`) is synced from the Infisical-fed `.env.local` by `scripts/sync-edge-secrets.mjs` through the per-key Worker secret API. Missing keys are skipped and leave any existing binding unchanged, so a deploy cannot reset self-host configuration accidentally; remove a gateway binding explicitly when disabling it.
- **Conversation runtime settings** (`AUTO_ARCHIVE_HOURS`, `BUTTR_INBOX_URL`, `EMAIL_ASSET_ORIGIN`) use the same optional per-key sync. The archive window defaults to 24 hours when unset. Set the inbox URL to the authenticated operator inbox for the target environment so lead-email links open a tenant-checked conversation. Set the asset origin to a public HTTPS host serving `/brand/buttr-chill.png`; missing or unsafe origins leave the text-only header. Keep preview and production URLs in their own Infisical environments.
- **Pilot AI and calls** use `GEMINI_API_KEY`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_URL`, and optional `LIVEKIT_CLIENT_URL` from the same environment feed. The sync script includes these keys when present, with the target Worker selected by `deploy.sh`; preview values must come from the preview Infisical folders.
- **Native call pilot** uses `PUSH_TRIGGER_SECRET` as the shared Core-to-Cloud offer and status credential. `NATIVE_CALLS_ENABLED` and `CALL_PILOT_TENANT_ID` are optional per-environment settings synced by the same script. Keep the exact pilot tenant ID during rollback so existing calls and signed LiveKit webhooks can finish cleanup. Only set `NATIVE_CALLS_ENABLED=1` after the matching Cloud API, push delivery, signed app, and preview call checks are ready. Missing keys leave existing Worker bindings unchanged; an explicit `0` disables new calls.
- **Browser call bundle** is staged by `./deploy.sh widget preview` from the pinned public `livekit-client@2.22.3` npm release. `scripts/stage-livekit-client.mjs` checks the UMD SHA-256 and copies its Apache-2.0 license into the static widget upload. Set `LIVEKIT_CLIENT_PACKAGE_DIR` to use an already installed package of the same version. Point `LIVEKIT_CLIENT_URL` at the deployed versioned asset; each preview widget deploy stages it again so the URL remains valid.
- **Lead email** uses `RESEND_API_KEY` and `LEAD_EMAIL_FROM` from Infisical. Set the sender to an address verified for that Resend account; the deploy syncs both to the edge Worker. A configured email connector's recipient address remains in tenant config. A form with a configured email connector now returns `delivery_failed` if Resend does not accept the send.
- **Same-zone gateway hosting:** the preview Worker includes Cloudflare's `global_fetch_strictly_public` compatibility flag because its URL-based gateway target is another Worker in the same zone. A self-hosted edge Worker that calls a same-zone custom gateway needs the equivalent compatibility setting in its environment; production remains unchanged unless its gateway is hosted the same way.
- **Deploy creds** (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) are fed from Infisical into a git-ignored `.env.local`, which [`deploy.sh`](../deploy.sh) sources (`set -a; . .env.local; set +a`) and [`scripts/cf-deploy-preflight.mjs`](../scripts/cf-deploy-preflight.mjs) asserts are present before any `wrangler deploy`. They are **never** committed and **never** placed in GitHub Actions — deploy is Tilt + wrangler, not CI.
- The API token needs: **Workers Scripts:Edit**, **Cloudflare Pages:Edit**, **Workers KV Storage:Edit** (Durable Objects are covered by Workers Scripts).

## Rules

- **Bindings are not secrets** (KV, Durable Objects) — they live in `wrangler.toml` / the Cloudflare project config, never in Infisical.
- One source of truth per environment; prefer the Infisical sync over per-platform `secret put` once you have more than one machine (hand-set `secret put` drifts).
