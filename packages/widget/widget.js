/*
 * Krispy AI — embeddable live-chat widget. Dependency-free, ~1 file, Shadow DOM
 * isolated (host-page CSS can't leak in). Talks to @krispy/edge:
 *   POST /api/chat            → instant AI reply
 *   WS   /api/session/:id/ws  → live operator replies (bot goes silent on handoff)
 *   POST /api/contact         → [!HANDOFF] contact capture
 *
 * Embed (one line):
 *   <script src="https://YOUR-HOST/widget.js"
 *           data-api="https://krispy-edge.YOU.workers.dev"
 *           data-tenant="self" async></script>
 */
(function () {
  "use strict";
  var script = document.currentScript;
  var cfg = {
    api: ((script && script.getAttribute("data-api")) || "").replace(/\/$/, ""),
    tenant: (script && script.getAttribute("data-tenant")) || "self",
    title: (script && script.getAttribute("data-title")) || "Chat with us",
    accent: (script && script.getAttribute("data-accent")) || "#e39a2b",
  };
  if (!cfg.api) return console.error("[krispy] missing data-api on <script>");

  // Default Buttr avatar — inline data-URI (self-contained; NEVER the private
  // ops/brand/stickers PNGs). A tiny croissant on cream, in brand gold/espresso.
  var BUTTR =
    "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='8'%20fill='%23fbf6ee'/%3E%3Cpath%20d='M6%2022c3-1%205-4%206-7%201%203%203%206%206%207-3%201-6%201-6%201s-4-.3-6-1z'%20fill='%23e39a2b'%20stroke='%23241a12'%20stroke-width='1.4'%20stroke-linejoin='round'/%3E%3C/svg%3E";

  // Sanitizers at the CSS trust boundary — a tenant-controlled string is about to
  // land in a stylesheet, so anything that isn't a plain color/number/font is dropped.
  function clampColor(v) {
    return typeof v === "string" && /^#[0-9a-fA-F]{3,8}$|^rgb/.test(v) ? v : null;
  }
  function clampRadius(v) {
    return typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(20, v)) : null;
  }
  function clampFont(v) {
    return typeof v === "string" && v && !/[;}<>]/.test(v) ? v : null;
  }

  // Stable per-visitor session id.
  var KEY = "krispy_session_" + cfg.tenant;
  var sessionId = localStorage.getItem(KEY);
  if (!sessionId) {
    sessionId =
      (crypto.randomUUID && crypto.randomUUID()) ||
      String(Date.now()) + Math.random().toString(16).slice(2);
    localStorage.setItem(KEY, sessionId);
  }

  var history = []; // {role, content} — sent for context, capped server-side
  var handedOff = false; // a human took over → hide the AI framing
  var ws = null;
  var keepalive = null;

  // ── UI (Shadow DOM) ─────────────────────────────────────────────────────
  var host = document.createElement("div");
  host.style.cssText = "position:fixed;bottom:20px;right:20px;left:auto;z-index:2147483000";
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: "open" });
  // Theme lives in :host custom properties → defaults render with NO fetch; the
  // boot fetch only overrides them. Colors reference cfg.accent so data-accent
  // still works as a pre-fetch default.
  root.innerHTML =
    "<style>" +
    ":host{--k-primary:" +
    cfg.accent +
    ";--k-launcher:var(--k-primary);--k-radius:14px;--k-font:-apple-system,Segoe UI,Roboto,sans-serif}" +
    "*{box-sizing:border-box;font-family:var(--k-font)}" +
    ".btn{width:56px;height:56px;border-radius:50%;border:0;background:var(--k-launcher)" +
    ";color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);font-size:24px;margin-bottom:env(safe-area-inset-bottom,0)}" +
    ".panel{display:none;flex-direction:column;width:380px;max-width:calc(100vw - 5.5rem);height:480px;max-height:min(500px,70dvh,var(--kvvh,100dvh));background:#fff;border-radius:var(--k-radius);overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.28)}" +
    "@keyframes kslide{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}" +
    ".panel.open{display:flex;animation:kslide .22s cubic-bezier(.16,1,.3,1)}" +
    "@media (prefers-reduced-motion:reduce){.panel.open{animation:none}}" +
    ".hd{background:var(--k-primary)" +
    ";color:#fff;padding:14px 16px;font-weight:600;display:flex;justify-content:space-between;align-items:center;gap:8px}" +
    ".hd .av{width:24px;height:24px;border-radius:50%;flex:0 0 auto;object-fit:cover}" +
    ".hd .ttl{flex:1}" +
    ".hd .x{cursor:pointer;opacity:.85;font-size:20px;line-height:1}" +
    ".log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f7f7f8}" +
    ".msg{max-width:80%;padding:8px 12px;border-radius:12px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}" +
    ".me{align-self:flex-end;background:var(--k-primary)" +
    ";color:#fff;border-bottom-right-radius:3px}" +
    ".bot{align-self:flex-start;background:#fff;color:#111;border:1px solid #e5e5e5;border-bottom-left-radius:3px}" +
    ".op{align-self:flex-start;background:#e7f6ec;color:#0a3d20;border:1px solid #b8e6c8;border-bottom-left-radius:3px}" +
    ".sys{align-self:center;font-size:12px;color:#888}" +
    ".ft{display:flex;border-top:1px solid #eee;padding:8px;padding-bottom:calc(8px + env(safe-area-inset-bottom,0));gap:6px}" +
    ".ft input{flex:1;border:1px solid #ddd;border-radius:8px;padding:9px 11px;font-size:16px;outline:none}" +
    ".ft button{border:0;background:var(--k-primary)" +
    ";color:#fff;border-radius:8px;padding:0 14px;cursor:pointer;font-size:14px}" +
    ".ft button:disabled{opacity:.5;cursor:default}" +
    ".cap{padding:10px 12px;background:#fff;border-top:1px solid #eee;display:none;flex-direction:column;gap:6px}" +
    ".cap.show{display:flex}.cap input{border:1px solid #ddd;border-radius:8px;padding:8px 10px;font-size:16px}" +
    ".cap button{border:0;background:#111;color:#fff;border-radius:8px;padding:8px;cursor:pointer;font-size:13px}" +
    "</style>" +
    '<div class="panel" part="panel">' +
    '<div class="hd"><img class="av" alt="" hidden><span class="ttl"></span><span class="x">&times;</span></div>' +
    '<div class="log"></div>' +
    '<form class="cap"><input class="cn" placeholder="Your name"><input class="cc" placeholder="Email or phone"><button type="submit">Leave contact</button></form>' +
    '<form class="ft"><input class="in" placeholder="Type a message…" autocomplete="off"><button type="submit">Send</button></form>' +
    "</div>" +
    '<button class="btn" aria-label="Open chat">💬</button>';

  var $ = function (s) {
    return root.querySelector(s);
  };
  var panel = $(".panel"),
    log = $(".log"),
    input = $(".in"),
    sendForm = $(".ft"),
    sendBtn = sendForm.querySelector("button");
  var capForm = $(".cap");
  var avatarEl = $(".av");
  $(".ttl").textContent = cfg.title;

  // ── theme (boot fetch, init-gated, NO poll — decorative → never blocks chat) ──
  var greeting = ""; // optional first bot bubble on open; set by theme
  function applyTheme(th) {
    if (!th) return;
    var pc = clampColor(th.primaryColor);
    if (pc) host.style.setProperty("--k-primary", pc);
    var lc = clampColor(th.launcherColor);
    if (lc) host.style.setProperty("--k-launcher", lc);
    var r = clampRadius(th.radius);
    if (r != null) host.style.setProperty("--k-radius", r + "px");
    var f = clampFont(th.font);
    if (f) host.style.setProperty("--k-font", f);
    if (th.position === "bl") {
      host.style.right = "auto";
      host.style.left = "20px";
    }
    if (typeof th.headerTitle === "string" && th.headerTitle)
      $(".ttl").textContent = th.headerTitle;
    if (typeof th.greeting === "string") greeting = th.greeting.trim();
    // avatar: literal "buttr" → inline default; an https URL → that; else nothing.
    var isHttps = typeof th.avatar === "string" && th.avatar.startsWith("https://");
    var av = th.avatar === "buttr" ? BUTTR : isHttps ? th.avatar : null;
    if (av) {
      avatarEl.src = av;
      avatarEl.hidden = false;
    }
  }
  fetch(cfg.api + "/api/widget/config?t=" + encodeURIComponent(cfg.tenant))
    .then(function (r) {
      return r.json();
    })
    .then(function (c) {
      applyTheme(c && c.theme);
    })
    .catch(function () {}); // theme is decorative; chat works without it

  function add(cls, text) {
    var d = document.createElement("div");
    d.className = "msg " + cls;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  // ── keyboard-aware floating card (visualViewport) ───────────────────────
  var vv = window.visualViewport;
  function syncViewport() {
    if (!vv) return; // desktop / unsupported → static card
    // gap the keyboard occupies at the bottom of the layout viewport
    var kb = window.innerHeight - (vv.height + vv.offsetTop);
    host.style.bottom = Math.max(20, kb) + "px";
    host.style.setProperty("--kvvh", vv.height + "px");
  }
  if (vv) {
    vv.addEventListener("resize", syncViewport);
    vv.addEventListener("scroll", syncViewport);
  }

  var opened = false;
  function open() {
    panel.classList.add("open");
    if (!opened) {
      opened = true;
      add("sys", "You're chatting with an AI assistant. A human can jump in anytime.");
      if (greeting) add("bot", greeting);
      connectWs();
    }
    syncViewport();
    setTimeout(function () {
      input.focus();
    }, 60); // transitionend never fires on a display-toggle
  }
  function closePanel() {
    panel.classList.remove("open");
    input.blur();
    host.style.bottom = "20px"; // reset the keyboard pin
  }
  $(".btn").addEventListener("click", function () {
    if (panel.classList.contains("open")) closePanel();
    else open();
  });
  $(".x").addEventListener("click", closePanel);

  // ── live channel (operator replies) ─────────────────────────────────────
  function connectWs() {
    try {
      var wsUrl =
        cfg.api.replace(/^http/, "ws") +
        "/api/session/" +
        encodeURIComponent(sessionId) +
        "/ws?t=" +
        encodeURIComponent(cfg.tenant);
      ws = new WebSocket(wsUrl);
      ws.onmessage = function (e) {
        if (e.data === "pong") return;
        var ev;
        try {
          ev = JSON.parse(e.data);
        } catch {
          return;
        }
        if (ev.type === "ready") {
          handedOff = !!ev.handedOff;
          if (handedOff) markHuman();
        } else if (ev.type === "operator") {
          handedOff = true;
          markHuman();
          add("op", ev.text);
        } else if (ev.type === "handoff") {
          showCapture();
        }
      };
      ws.onclose = function () {
        setTimeout(connectWs, 3000);
      }; // reconnect
      // keepalive so proxies don't idle-close (hibernation-friendly)
      ws.onopen = function () {
        clearInterval(keepalive);
        keepalive = setInterval(function () {
          try {
            ws.send("ping");
          } catch {
            /* closing */
          }
        }, 30000);
      };
    } catch {
      /* WS optional; POST still works */
    }
  }

  var humanMarked = false;
  function markHuman() {
    if (humanMarked) return;
    humanMarked = true;
    add("sys", "A team member has joined the chat.");
  }

  // ── contact capture (on [!HANDOFF]) ─────────────────────────────────────
  function showCapture() {
    capForm.classList.add("show");
  }
  capForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var name = capForm.querySelector(".cn").value.trim();
    var contact = capForm.querySelector(".cc").value.trim();
    if (!contact && !name) return;
    fetch(cfg.api + "/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: sessionId,
        tenantId: cfg.tenant,
        name: name,
        contact: contact,
      }),
    }).catch(function () {});
    capForm.classList.remove("show");
    add("sys", "Thanks — we'll reach out.");
  });

  // ── send ─────────────────────────────────────────────────────────────────
  sendForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    add("me", text);
    history.push({ role: "user", content: text });
    sendBtn.disabled = true;
    var typing = handedOff ? null : add("bot", "…");
    fetch(cfg.api + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: sessionId,
        tenantId: cfg.tenant,
        message: text,
        history: history.slice(-10),
      }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (res) {
        if (typing) typing.remove();
        if (res.handedOff) {
          handedOff = true;
          markHuman();
          return;
        } // human owns it — stay silent
        if (res.reply) {
          add(res.degraded ? "op" : "bot", res.reply);
          history.push({ role: "assistant", content: res.reply });
        }
        if (res.handoff) showCapture();
      })
      .catch(function () {
        if (typing) typing.remove();
        add("sys", "Connection issue — please try again.");
      })
      .finally(function () {
        sendBtn.disabled = false;
        input.focus();
      });
  });
})();
