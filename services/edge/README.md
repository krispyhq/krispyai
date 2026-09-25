# @krispy/edge

The live-chat + human-handoff backend. **One Cloudflare Worker** hosts both the
`/api/*` routes and the `SessionDO` Durable Object — a single deploy, one
`wrangler.toml`, runnable end-to-end under `wrangler dev`.

> Design note: the brief said "Pages Functions + a Worker/DO". There's no static
> site to host here (the widget embeds on the _customer's_ site) and a DO must live
> in a Worker regardless, so a lone Worker is strictly simpler — fewer moving parts,
> one origin, no Pages↔Worker binding dance. The route layout maps 1:1 to Pages
> Functions if you ever want to split them.

## The loop

```
visitor ──POST /api/chat──▶ Worker ──▶ Workers AI ──▶ reply ──▶ visitor
                              │                │
                              │                └─ escalation → pending; AI goes silent
                              └─▶ Telegram: one forum TOPIC per visitor (owner's phone)
owner replies in topic ──POST /api/telegram/webhook──▶ Worker
                              │
                              └─▶ SessionDO ──WebSocket──▶ visitor's browser (live)
                                             + pending → operator
```

**Quiet ops.** Routine mirrors (visitor msgs, AI replies) post to the topic
**silently** (`disable_notification`) — mute the group and you still get a full
transcript without your phone buzzing. The **only** loud message is the handoff
alert, which `@mentions` the tenant's `operators` (via `text_mention` entities —
works with no public username). Operators are **auto-learned**: whoever replies in
a managed topic is upserted (capped at 10). No operators yet → the alert still
fires, just without a mention. See `docs → connect Telegram`.

## Endpoints

Configured lead forms can forward the visitor's recent chat to an email connector.
Set `RESEND_API_KEY` and a verified `LEAD_EMAIL_FROM` through Infisical; a failed
email delivery returns `502 delivery_failed` so the widget keeps the form ready
for another attempt.
The lead email includes labeled contact details, the recent conversation, a
plain-text part, and an optional **Open in Buttr** action. Configure the
Worker-side `BUTTR_INBOX_URL` to an HTTPS operator inbox URL (localhost HTTP is
allowed for development). The Worker adds the session ID as a query parameter;
the inbox must authenticate the operator and confirm the session belongs to
their tenant before selecting it. If the URL is unset, the email still includes
the details and transcript without the action.
The authenticated operator action routes list configured forms and Instagram CTAs
for a session's recorded site, then send a selected ID as a durable typed card.
The visitor receives it over the session WebSocket and sees it again after reconnecting.
Bot-only sessions archive after 24 hours without a new visitor message by default;
`AUTO_ARCHIVE_HOURS` configures that window. A new live visitor message reopens the
session. Handoffs, human replies, and call requests remain available for manual
resolution even if ownership has returned to AI. An inbox read archives eligible
older bot-only sessions that predate the timer; it leaves uncertain legacy human
requests active.
Reply suggestions remain editable and unsent. Checkout links in a suggestion must
match the tenant's configured sources or validated knowledge gateway context;
ordinary sentence punctuation after an approved URL does not hide the suggestion.
When the saved transcript ends in an AI reply, drafting asks for a fresh operator
response to the latest visitor request. The Delulus pilot requests structured JSON
from Gemini for this action only; normal visitor chat keeps its existing output mode.

| method | path                             | purpose                                                                                                  |
| ------ | -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| POST   | `/api/chat`                      | `{sessionId, message, tenantId?, history?}` → `{reply, handoff, handoffState, handedOff, degraded?}`     |
| POST   | `/api/contact`                   | `[!HANDOFF]` contact-capture → owner's topic                                                             |
| POST   | `/api/operator/actions`          | list configured forms and Instagram CTAs for an authenticated operator's session                         |
| POST   | `/api/operator/send-action`      | send one configured form or Instagram card into that session                                             |
| POST   | `/api/operator/reply-drafts`     | generate up to three editable, tenant-grounded operator replies; never sends them                        |
| POST   | `/api/telegram/webhook`          | owner reply → push to visitor via DO                                                                     |
| POST   | `/api/billing/entitlement`       | billing → gate: mirror an entitlement snapshot into KV _(secret-guarded)_                                |
| GET    | `/api/tenant/config?t=<tenant>`  | read a tenant's config `{botToken, chatId, systemPrompt?, model?}`, 404 if none _(secret-guarded)_       |
| POST   | `/api/tenant/config`             | `{tenantId, config}` merge into the tenant's KV config — the `krispy` CLI writes here _(secret-guarded)_ |
| GET    | `/api/session/:id/ws?t=<tenant>` | visitor's live channel (WebSocket → DO)                                                                  |
| GET    | `/api/usage?t=<tenant>`          | metering + plan readout (`usage` also carries approx `tokens`)                                           |
| GET    | `/health`                        | liveness                                                                                                 |

### Cost knobs — the "turn tax"

Each chat turn re-sends the whole history to the LLM, so naive cost grows quadratically
with conversation length. Three bounds (all optional env vars; code defaults shown) keep
per-turn cost flat, without changing product behavior on normal short chats:

| env var             | default | why                                                                                                                                                                            |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MAX_HISTORY_MSGS`  | `8`     | Sliding window — the AI only sees the last N prior messages (system + latest user always kept, oldest turns trimmed). Caps the input that grows every turn.                    |
| `MAX_OUTPUT_TOKENS` | `256`   | Hard cap on reply length (output tokens are ~4–5× the price of input). A brevity line is also appended to the system prompt so the cap rarely bites.                           |
| `MAX_AI_TURNS`      | `10`    | After N AI turns in a session with no resolution, hand off to a human instead of paying for another (likely-looping) turn — cost _and_ UX. Generous: short chats never hit it. |

Metering now also tracks approximate tokens (`chars/4` estimate, since Workers AI's
response exposes no usage counts) under the `usage:<tenant>:<yyyymm>:tokens` KV counter,
surfaced as `tokens` in `/api/usage`. Prompt caching is N/A on Workers AI (no
`cache_control` knob); the BYO-key adapter seam in `ai.ts` is where it plugs in later.

### Optional private knowledge gateway

The Worker can add cited support evidence from a private gateway immediately before the
model call. Set `KNOWLEDGE_GATEWAY_URL`, `KNOWLEDGE_GATEWAY_SECRET`, and the exact
`KNOWLEDGE_TENANT_ID`; `KNOWLEDGE_SITE_ID` defaults to the default site and
`KNOWLEDGE_TIMEOUT_MS` defaults to 250. These are Worker settings only and never enter
the public widget config. The gateway receives `{ requestId, tenantId, siteId, question }`
with a bearer secret and must return `{ evidence: [{ text, sourceId, revision, title?, url? }], guidance?: [{ text, sourceId, revision, title? }] }`.
Evidence is business reference data. Optional guidance is one bounded professional-method
reference (20,000 characters total); it is never a business claim or an instruction that
overrides security, privacy, tenant scope, handoff, or human-review rules. The edge rejects
cross-scope, malformed, oversized, or unsafe responses and caps request and response bodies at 64 KiB.
It adds the trusted current UTC time when composing a retrieved reference. Missing
configuration, operator-owned sessions, timeouts, errors, or no usable retrieval use the
existing AI path unchanged.
The private gateway owns provider credentials and Longstory-specific code.

The browser widget sends its current visitor line at the end of `history` before posting
`/api/chat`. On a first-message handoff, the Worker removes only that trailing exact match
from the empty-ring seed and then appends the live turn once. Earlier identical questions
are preserved; history entries that do not end with the current line are seeded unchanged.

### Tenant-config sync (the `krispy` CLI → gate)

The `krispy` CLI (`packages/cli`) — or Krispy Cloud, or your own tooling — manages a
tenant's optional Telegram creds + prompt/model over `/api/tenant/config`. Both routes require the header
`x-tenant-sync-secret: <TENANT_SYNC_SECRET>` — the payload holds a **bot token**, so
without the secret they return **401** and never leak config. POST **merges** (unset
fields are preserved), writing the exact KV shape `getTenant()` reads (key
`tenant:<tenantId>`). A Cloud tenant's prompt/theme/forms work without Telegram; Buttr
handles operator handoff. Screenshot forwarding remains Telegram-backed, so the public
widget config reports that capability as unavailable for app-only tenants.

Secrets are separate on purpose: `TENANT_SYNC_SECRET` guards the config sync (the
`krispy` CLI uses it); `BILLING_SYNC_SECRET` guards the optional billing→gate push
(unused in single-tenant self-host). Set either with `bunx wrangler secret put <NAME>`.

The Buttr operator surface verifies its bearer against the cloud API's `GET /me` and
authorizes against the server-resolved `tenantId`, so verified teammates share the owner's
tenant access. A legacy `/me` response without `tenantId` falls back to its nonempty `id`;
malformed identity fields fail closed.

## Architecture

- **`SessionDO`** — one per `(tenantId, sessionId)`. Uses `state.acceptWebSocket()`
  (hibernation) so idle sockets cost **nothing**. Holds the strongly-consistent
  handoff state: `ai` → `pending` as soon as a human is requested → `operator` on the
  first human reply. Both human states silence AI; resolve/silence handback restores `ai`.
  The legacy `handedOff` response flag remains true only for `operator`.
- **KV (`KRISPY_KV`)** — topic↔session map (`thread:`/`session:`), Telegram-independent
  Buttr discovery (`handoff:<tenant>:<sessionId>`), tenant config (`tenant:`), and usage
  counters (`usage:<tenant>:<yyyymm>:<kind>`). The inbox unions new handoff keys with legacy
  topic mappings, so existing sessions remain visible.
- **`tenantId`** — default `"self"` (single-tenant self-host, config from secrets);
  any other id reads config from KV. Same code path both ways.
- **Metering** — every AI call + handoff increments a KV counter; `planFor()` /
  `withinPlan()` are the plan-gate seam (unlimited for `self` today).
- **Graceful degradation** — AI down → still hands off to a human (never drops the
  visitor); Telegram unconfigured → chat and Buttr handoff still work, topic operations
  no-op, and screenshot paste/drop stays disabled.
- **AI adapter** — Workers AI remains the default. For the Delulus pilot only,
  set its model to `gemini-3.1-flash-lite` and configure the Worker secret
  `GEMINI_API_KEY`. The Gemini runner requires an exact match to the existing
  `KNOWLEDGE_TENANT_ID` and `KNOWLEDGE_SITE_ID` (empty/default is the same site).
  Other tenants stay on Workers AI even if their model setting names Gemini.
  The key stays server-side. If it is missing or Google fails, that Delulus turn
  falls back to the existing Cloudflare 70B model; human handoff still applies
  if both providers fail. No tenant is
  switched by merely deploying the adapter. The bracketed `[!HANDOFF]` marker
  remains canonical; a bare terminal
  `!HANDOFF` is accepted only as a compatibility variant when sentence-standalone.
  The explicitly selected `@cf/meta/llama-3.1-8b-instruct-fast` candidate uses temperature
  0 for repeatability; the default 70B model is unchanged. A control-only handoff still
  sends the visitor an acknowledgement while the human takes over.
  It accepts both the legacy `response` field and OpenAI-shaped
  `choices[0].message.content` final text; reasoning-only output fails closed.

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
   enable **Topics** in group settings, add your bot as an **admin** (needs _Manage
   Topics_). Get the chat id (e.g. via [@RawDataBot], looks like `-1001234567890`) →
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

### Public launcher configuration

The secret-free widget config projection includes `theme.launcherStyle` (`circle` or
`pill`) and `theme.launcherLabel`. Set these with the authenticated tenant-config route;
no widget embed change is required. The widget limits the displayed label to 24 characters.

### Hosted owner notifications

The hosted edge needs `PUSH_TOKENS_URL` set to its matching cloud API
`/internal/push/tokens` endpoint and `PUSH_TOKENS_SECRET` set to the shared
server credential. The preview deployment config supplies the preview endpoint.
Without the URL, chat and inbox persistence work but mobile push is skipped.
A signed device build, notification permission, registered device token, and
valid platform push credentials are also required; simulator chat tests do not
prove notification delivery. Self-hosted installations may leave these unset.

# Visitor audio calls (optional)

Audio calls are off until the Worker has `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, and `LIVEKIT_CLIENT_URL`. The first two credentials belong to
the same LiveKit deployment as the `wss://` URL. Set the key and secret as Worker
secrets; set the URLs as environment vars. `LIVEKIT_CLIENT_URL` must point to a
trusted, pinned UMD build of `livekit-client` that exposes `window.LivekitClient`
(for example, a self-hosted copy of the 2.22.3 UMD bundle). Serve it over HTTPS.
The browser loads this bundle only after the visitor accepts a call. A local
LiveKit server may use `ws://localhost` during development. There is no LiveKit
deployment or credential in this repository, so a production call needs the
operator to supply these four values and a reachable LiveKit service.

An authenticated operator invites through `POST /api/operator/call` with
`{tenantId,sessionId,action:"invite"}`. The widget's first chat message registers
a separate random visitor capability in the session Durable Object. The invite
is accepted only while a visitor socket presenting that capability is connected;
otherwise the operator receives `visitor_unavailable`. It appears on that socket
with a private invitation
nonce. A visitor must explicitly accept before either participant can get a
room token or the widget asks for microphone access. `status`, `cancel`, `end`,
and `grant` use the same operator endpoint; visitor `status`, `accept`, `decline`,
`end`, and `grant` use `POST /api/call` with the widget capability. Include the
returned call ID for every action after `invite`; the visitor includes the
nonce for `accept`, `decline`, and `end`. `grant` returns a two-minute,
microphone-only LiveKit token for the single opaque room. Ending calls LiveKit's
`DeleteRoom` API to disconnect participants. Self-hosted LiveKit cannot revoke a
previously issued token, so a cached token may reconnect until its short expiry;
new grants stop immediately when the Durable Object state ends. The invitation
expires after 60 seconds; an accepted call has a one-hour ceiling. The session
Durable Object schedules both deadlines alongside its existing handoff timer and
retries room deletion if LiveKit is temporarily unavailable.
