# @krispy/widget

The embeddable live-chat widget. One dependency-free `widget.js`, isolated in a
Shadow DOM (host-page CSS can't leak in). It talks to [`@krispy/edge`](../../services/edge).

## Embed

Host `widget.js` anywhere static (your CDN, the edge Worker's origin, an R2/Pages
bucket) and drop one tag on any page:

```html
<script
  src="https://widget.krispyai.com/widget.js"
  data-api="https://edge.krispyai.com"
  data-tenant="self"
  async
></script>
```

| attribute     | required | default        | meaning                                              |
| ------------- | -------- | -------------- | ---------------------------------------------------- |
| `data-api`    | yes      | —              | the `@krispy/edge` Worker base URL                   |
| `data-tenant` | no       | `self`         | tenant id (multi-tenant SaaS uses this)              |
| `data-title`  | no       | `Chat with us` | header text                                          |
| `data-accent` | no       | `#e39a2b`      | brand color (used before the KV `theme` fetch lands) |

## The loop

1. Visitor types → `POST /api/chat` → instant AI reply (Workers AI).
2. Every visitor message is mirrored to the owner's Telegram (one topic per visitor).
3. Owner replies from their phone → the widget's WebSocket (`/api/session/:id/ws`)
   pushes it in live, and **the AI goes silent** — the human owns the conversation.
4. When the AI hits its limit it appends `[!HANDOFF]`; the widget then shows a
   small contact-capture form (`POST /api/contact`).

## Optional: ask for an email first

Off by default. When the tenant config sets `identify: { require: "email" }`, the boot
config carries an `identify` block and the widget locks its composer behind a small card
until the visitor gives an address. The address is kept in
`localStorage["krispy_identity_<tenant>"]` (so a returning visitor isn't asked twice) and
re-sent on every `POST /api/chat`.

The widget is **not** the gate — the edge is. It re-validates the address on every turn and
answers `403 { error: "identity_required" }` without one; the widget raises the card on that
response even if its boot config said nothing, so the server always wins. With `identify`
unset, none of this code path runs and the widget behaves exactly as it did before.

See [docs → `IdentifySpec`](../../apps/docs/content/docs/reference/tenant-config.mdx) and
[docs → security](../../apps/docs/content/docs/security.mdx).

## Local demo

Run the edge Worker (`cd services/edge && bunx wrangler dev`, serves on `:8787`),
then open `index.html` (it points `data-api` at `http://localhost:8787`). Serve it
over http so the WebSocket and `localStorage` work, e.g. `bunx serve packages/widget`.
