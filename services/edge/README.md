# @krispy/edge

The live-chat + human-handoff backend. **One Cloudflare Worker** hosts both the
`/api/*` routes and the `SessionDO` Durable Object — a single deploy, one
`wrangler.toml`, runnable end-to-end under `wrangler dev`.

> Design note: the brief said "Pages Functions + a Worker/DO". There's no static
> site to host here (the widget embeds on the *customer's* site) and a DO must live
> in a Worker regardless, so a lone Worker is strictly simpler — fewer moving parts,
> one origin, no Pages↔Worker binding dance. The route layout maps 1:1 to Pages
> Functions if you ever want to split them.

## The loop

```
visitor ──POST /api/chat──▶ Worker ──▶ Workers AI ──▶ reply ──▶ visitor
                              │
                              └─▶ Telegram: one forum TOPIC per visitor (owner's phone)
owner replies in topic ──POST /api/telegram/webhook──▶ Worker
                              │
                              └─▶ SessionDO ──WebSocket──▶ visitor's browser (live)
                                             + set handedOff=true → AI goes silent
```

## Endpoints

| method | path | purpose |
|--------|------|---------|
| POST | `/api/chat` | `{sessionId, message, tenantId?, history?}` → `{reply, handoff, handedOff, degraded?}` |
| POST | `/api/contact` | `[!HANDOFF]` contact-capture → owner's topic |
| POST | `/api/telegram/webhook` | owner reply → push to visitor via DO |
| GET | `/api/session/:id/ws?t=<tenant>` | visitor's live channel (WebSocket → DO) |
| GET | `/api/usage?t=<tenant>` | metering + plan readout |
| GET | `/health` | liveness |

## Architecture

- **`SessionDO`** — one per `(tenantId, sessionId)`. Uses `state.acceptWebSocket()`
  (hibernation) so idle sockets cost **nothing**. Holds the strongly-consistent
  `handedOff` flag (KV is too eventually-consistent for an instant bot-silence switch).
- **KV (`KRISPY_KV`)** — topic↔session map (`thread:`/`session:`), tenant config
  (`tenant:`), usage counters (`usage:<tenant>:<yyyymm>:<kind>`).
- **`tenantId`** — default `"self"` (single-tenant self-host, config from secrets);
  any other id reads config from KV. Same code path both ways.
- **Metering** — every AI call + handoff increments a KV counter; `planFor()` /
  `withinPlan()` are the plan-gate seam (unlimited for `self` today).
- **Graceful degradation** — AI down → still hands off to a human (never drops the
  visitor); Telegram unconfigured → chat still answers, topic ops no-op.
- **AI adapter** — Workers AI default (`workersAiRunner`); the `AiRunner` type is the
  BYO-key seam.

## Run locally

```sh
cd services/edge
bun test                 # unit tests (no external services needed)
bunx wrangler dev        # serves on http://localhost:8787
```

`wrangler dev` binds Workers AI + the DO automatically. KV needs a namespace id in
`wrangler.toml` (see below); for a pure local run `wrangler dev --local` uses a
simulated KV.

## Go fully live (service-gated steps)

1. **KV namespace** — `bunx wrangler kv namespace create KRISPY_KV`, paste the id
   into `wrangler.toml` (`REPLACE_WITH_KV_ID`).
2. **Telegram bot** — talk to [@BotFather](https://t.me/BotFather) → `/newbot` →
   copy the token. Then `bunx wrangler secret put TELEGRAM_BOT_TOKEN`.
3. **Supergroup with Topics** — create a Telegram group, upgrade it to a supergroup,
   enable **Topics** in group settings, add your bot as an **admin** (needs *Manage
   Topics*). Get the chat id (e.g. via [@RawDataBot], looks like `-1001234567890`) →
   `bunx wrangler secret put TELEGRAM_CHAT_ID`.
4. **Webhook secret** — pick a random string →
   `bunx wrangler secret put TELEGRAM_WEBHOOK_SECRET`.
5. **Deploy** — `bunx wrangler deploy`.
6. **Register the webhook** with Telegram (points it at the deployed Worker):
   ```sh
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://krispy-edge.YOU.workers.dev/api/telegram/webhook" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   ```
7. **Embed the widget** (see [`packages/widget`](../../packages/widget)) with
   `data-api="https://krispy-edge.YOU.workers.dev"`.

That's it — a visitor message now opens a topic on your phone, and your reply from
Telegram appears live in their browser with the AI silenced.
