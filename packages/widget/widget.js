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
    accent: (script && script.getAttribute("data-accent")) || "#e8552d",
  };
  if (!cfg.api) return console.error("[krispy] missing data-api on <script>");

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
  host.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:2147483000";
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    "<style>" +
    "*{box-sizing:border-box;font-family:-apple-system,Segoe UI,Roboto,sans-serif}" +
    ".btn{width:56px;height:56px;border-radius:50%;border:0;background:" +
    cfg.accent +
    ";color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);font-size:24px}" +
    ".panel{display:none;flex-direction:column;width:340px;max-width:calc(100vw - 40px);height:480px;max-height:calc(100vh - 120px);background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.28)}" +
    ".panel.open{display:flex}" +
    ".hd{background:" +
    cfg.accent +
    ";color:#fff;padding:14px 16px;font-weight:600;display:flex;justify-content:space-between;align-items:center}" +
    ".hd .x{cursor:pointer;opacity:.85;font-size:20px;line-height:1}" +
    ".log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f7f7f8}" +
    ".msg{max-width:80%;padding:8px 12px;border-radius:12px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}" +
    ".me{align-self:flex-end;background:" +
    cfg.accent +
    ";color:#fff;border-bottom-right-radius:3px}" +
    ".bot{align-self:flex-start;background:#fff;color:#111;border:1px solid #e5e5e5;border-bottom-left-radius:3px}" +
    ".op{align-self:flex-start;background:#e7f6ec;color:#0a3d20;border:1px solid #b8e6c8;border-bottom-left-radius:3px}" +
    ".sys{align-self:center;font-size:12px;color:#888}" +
    ".ft{display:flex;border-top:1px solid #eee;padding:8px;gap:6px}" +
    ".ft input{flex:1;border:1px solid #ddd;border-radius:8px;padding:9px 11px;font-size:14px;outline:none}" +
    ".ft button{border:0;background:" +
    cfg.accent +
    ";color:#fff;border-radius:8px;padding:0 14px;cursor:pointer;font-size:14px}" +
    ".ft button:disabled{opacity:.5;cursor:default}" +
    ".cap{padding:10px 12px;background:#fff;border-top:1px solid #eee;display:none;flex-direction:column;gap:6px}" +
    ".cap.show{display:flex}.cap input{border:1px solid #ddd;border-radius:8px;padding:8px 10px;font-size:13px}" +
    ".cap button{border:0;background:#111;color:#fff;border-radius:8px;padding:8px;cursor:pointer;font-size:13px}" +
    "</style>" +
    '<div class="panel" part="panel">' +
    '<div class="hd"><span class="ttl"></span><span class="x">&times;</span></div>' +
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
  $(".ttl").textContent = cfg.title;

  function add(cls, text) {
    var d = document.createElement("div");
    d.className = "msg " + cls;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  var opened = false;
  function open() {
    panel.classList.add("open");
    if (!opened) {
      opened = true;
      add("sys", "You're chatting with an AI assistant. A human can jump in anytime.");
      connectWs();
    }
    input.focus();
  }
  $(".btn").addEventListener("click", function () {
    if (panel.classList.contains("open")) panel.classList.remove("open");
    else open();
  });
  $(".x").addEventListener("click", function () {
    panel.classList.remove("open");
  });

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
