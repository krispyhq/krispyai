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

| attribute       | required | default        | meaning                                              |
| --------------- | -------- | -------------- | ---------------------------------------------------- |
| `data-api`      | yes      | —              | the `@krispy/edge` Worker base URL                   |
| `data-tenant`   | no       | `self`         | tenant id (multi-tenant SaaS uses this)              |
| `data-title`    | no       | `Chat with us` | header text                                          |
| `data-accent`   | no       | `#e39a2b`      | brand color (used before the KV `theme` fetch lands) |
| `data-launcher` | no       | (built-in)     | `none` suppresses the built-in launcher button       |

## Bring your own launcher

The theme restyles the built-in launcher; it can't replace it. A brand with its own animated
mark sets `data-launcher="none"` and drives the panel itself:

```html
<button id="support" type="button">support</button>
<script>
  document.getElementById("support").addEventListener("click", function () {
    if (window.krispy) window.krispy.toggle(); // guard: widget.js is async
  });
</script>
```

- **`window.krispy`** — `open()`, `close()`, `toggle()`, `isOpen() → boolean`,
  `unread() → boolean`, `el` (the host element). Commands live on a global because a caller
  needs an answer back; a dispatched event can't return one.
- **events on `document`** — `krispy:open`, `krispy:close`, and
  `krispy:unread` (`detail: { unread: boolean }`, for your own dot when an operator replies).
  State is pushed, not polled: the panel also opens from paths you never called (a teaser
  popup, `autoOpenMs`, the panel's `×`), and a listener can be registered before this async
  script has run.
- **the host element** carries `class="krispy-widget"` — select that, not the z-index in its
  inline style.

All opt-in. Leave `data-launcher` off and the built-in launcher renders exactly as before.

## The loop

1. Visitor types → `POST /api/chat` → instant AI reply (Workers AI).
2. Every visitor message is mirrored to the owner's Telegram (one topic per visitor).
3. Owner replies from their phone → the widget's WebSocket (`/api/session/:id/ws`)
   pushes it in live, and **the AI goes silent** — the human owns the conversation.
4. When the AI hits its limit it appends `[!HANDOFF]`; the widget then shows a
   small contact-capture form (`POST /api/contact`).

## Local demo

Run the edge Worker (`cd services/edge && bunx wrangler dev`, serves on `:8787`),
then open `index.html` (it points `data-api` at `http://localhost:8787`). Serve it
over http so the WebSocket and `localStorage` work, e.g. `bunx serve packages/widget`.
