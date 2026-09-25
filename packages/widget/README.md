# @krispy/widget

The embeddable live-chat widget. One dependency-free `widget.js`, isolated in a
Shadow DOM (host-page CSS can't leak in). It talks to [`@krispy/edge`](../../services/edge).

The panel uses a light continuous conversation surface, with Buttr floating as the expressive
launcher. A tenant can opt into a colored mascot badge with `theme.launcherColor`.
Tenant accents color visitor messages and actions. Text keeps Krispy's brand ink when it reaches
4.5:1 contrast, then automatically uses black or white for darker custom colors.

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
2. The AI answers from the tenant's prompt and knowledge. Telegram mirroring is optional;
   app-only Cloud tenants use the Buttr owner inbox.
3. When the AI appends `[!HANDOFF]`, the session becomes `pending`: the widget shows one
   truthful waiting line, later messages still reach the operator, and the AI stays silent.
   Handoff never requires contact details; only a business-configured form may collect them.
4. An operator reply arrives live over the widget's WebSocket (`/api/session/:id/ws`) and
   moves the session to `operator`. Until that first reply, reconnects say the team was
   notified without claiming someone joined.
5. Resolve or silence handback restores `ai`, so the assistant can answer again.

Screenshot paste/drop is enabled only when the public boot config reports a Telegram-backed
attachment channel. App-only tenants do not present an upload path that would fail at send time.

## Audio call join errors

The visitor chooses **Join call** after accepting an invitation. If the browser
blocks microphone access, no device is found, or the media connection fails,
the card returns to Join and shows what to try next. The hosting page must
allow `microphone=(self)` in its `Permissions-Policy` for the browser to show
its consent prompt; `microphone=()` prevents a prompt and blocks capture.
Permission is still requested only after the visitor chooses Join.

A real incoming team invitation plays a repeating browser ringtone when sound is
enabled and the browser permits audio. The visible **Accept** and **Decline**
controls remain available if autoplay blocks sound. The ringtone stops when the
invitation is accepted, declined, canceled, expires, or the page/socket leaves.
The idle call suggestion and a visitor's own request stay silent. Hidden tabs do
not ring; browser autoplay settings may still prevent audible playback until a
trusted gesture unlocks audio on that page.
The widget only attempts silent unlock on widget interaction, including an
embedder's custom launcher opening the panel; unrelated page clicks do not
create an audio context.

After a visitor has registered a call capability through chat, returning to the
page reconnects its authenticated call socket while the page is visible, even
with the chat panel closed. The server still verifies the stored capability;
opening a new, unregistered page does not create call presence. Hidden pages and
unloaded pages close the socket, and a visible return reconnects it.

The idle **Speak with a team member** suggestion has a **Dismiss call offer**
button. Dismissal is remembered for the current tenant, site, and chat session,
including page reloads; a later new handoff or new chat session may show it again.
Dismissal does not decline an incoming invite or end a ringing or connected call.

During a call, choose **Audio settings** on the call card to expand device
controls. The microphone menu lists already permitted inputs and changes the
active LiveKit track; opening settings does not request microphone permission.
The speaker menu appears only in browsers that support selecting an audio
output and report multiple outputs. Otherwise output follows the device's
system route. Mute and End call remain available in the compact card.

## Local demo

Run the edge Worker (`cd services/edge && bunx wrangler dev`, serves on `:8787`),
then open `index.html` (it points `data-api` at `http://localhost:8787`). Serve it
over http so the WebSocket and `localStorage` work, e.g. `bunx serve packages/widget`.
