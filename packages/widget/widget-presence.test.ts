import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const source = readFileSync(new URL("./widget.js", import.meta.url), "utf8");
const capability = "A".repeat(43); // synthetic, never a live visitor credential

function mount(restored: boolean) {
  const window = new Window({ url: "https://preview.example/course" });
  const sessionId = "synthetic-restored-session";
  if (restored) {
    window.localStorage.setItem("krispy_session_tenant", sessionId);
    window.localStorage.setItem(`krispy_call_cap_tenant_${sessionId}`, capability);
  }
  const sockets: FakeSocket[] = [];
  const intervals = new Set<number>();
  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = FakeSocket.OPEN;
    onmessage?: (event: { data: string }) => void;
    onopen?: () => void;
    onclose?: () => void;
    constructor(readonly url: string) {
      sockets.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    send() {}
    close() {
      if (this.readyState === FakeSocket.CLOSED) return;
      this.readyState = FakeSocket.CLOSED;
      this.onclose?.();
    }
    addEventListener() {}
    receive(event: object) {
      this.onmessage?.({ data: JSON.stringify(event) });
    }
  }
  const script = window.document.createElement("script");
  script.dataset.api = "https://edge.example";
  script.dataset.tenant = "tenant";
  Object.defineProperty(window.document, "currentScript", { configurable: true, value: script });
  const fetches: string[] = [];
  const fetch = async (url: string) => {
    fetches.push(url);
    return { json: async () => ({}) };
  };
  // Mount the complete production widget with a real Shadow DOM and controlled
  // WebSocket transport. Only public synthetic URLs/credentials are used.
  // oxlint-disable-next-line typescript/no-implied-eval
  new Function(
    "window",
    "document",
    "localStorage",
    "sessionStorage",
    "crypto",
    "fetch",
    "WebSocket",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "CustomEvent",
    "Event",
    source,
  )(
    window,
    window.document,
    window.localStorage,
    window.sessionStorage,
    window.crypto,
    fetch,
    FakeSocket,
    window.setTimeout.bind(window),
    window.clearTimeout.bind(window),
    (callback: () => void, delay: number) => {
      const id = window.setInterval(callback, delay);
      intervals.add(id);
      return id;
    },
    (id: number) => {
      intervals.delete(id);
      window.clearInterval(id);
    },
    window.CustomEvent,
    window.Event,
  );
  const root = window.krispy?.el.shadowRoot;
  if (!root) throw new Error("widget failed to initialize");
  return { window, root, sockets, intervals, fetches, sessionId };
}

test("a restored visitor is call-present while the page is open and chat panel stays closed", async () => {
  const app = mount(true);
  try {
    expect(app.sockets).toHaveLength(1);
    expect(app.sockets[0]!.url).toContain(
      `/api/session/${app.sessionId}/ws?t=tenant&v=${capability}`,
    );
    expect(app.fetches.some((url) => url.includes("/api/chat"))).toBe(false);
    app.sockets[0]!.receive({
      type: "ready",
      handoffState: "operator",
      messages: [{ role: "operator", text: "Earlier reply", ts: 1_000 }],
    });
    app.sockets[0]!.receive({ type: "operator", text: "Earlier reply", ts: 1_000 });
    expect(app.root.querySelectorAll(".msg.op")).toHaveLength(0);
    app.window.krispy?.open();
    expect(app.root.querySelectorAll(".msg.op")).toHaveLength(1);
    expect(app.sockets).toHaveLength(1);
    Object.defineProperty(app.window.document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    app.window.document.dispatchEvent(new app.window.Event("visibilitychange"));
    expect(app.sockets[0]!.readyState).toBe(3);
    Object.defineProperty(app.window.document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    app.window.document.dispatchEvent(new app.window.Event("visibilitychange"));
    expect(app.sockets).toHaveLength(2);
    await Promise.resolve(); // replacement socket's open callback installs keepalive
    expect(app.intervals.size).toBe(1);
    app.sockets[0]!.onclose?.(); // stale close must not clear the new heartbeat
    expect(app.intervals.size).toBe(1);
    app.window.dispatchEvent(new app.window.Event("pagehide"));
    expect(app.sockets[1]!.readyState).toBe(3);
    app.window.dispatchEvent(new app.window.Event("pageshow")); // bfcache restore
    expect(app.sockets).toHaveLength(3);
  } finally {
    void app.window.happyDOM.abort();
  }
});

test("a new unregistered visitor does not claim call presence before opening chat", async () => {
  const app = mount(false);
  try {
    expect(app.sockets).toHaveLength(0);
    app.window.krispy?.open();
    expect(app.sockets).toHaveLength(1);
  } finally {
    void app.window.happyDOM.abort();
  }
});

test("an incoming invite still opens the closed chat panel on a restored page", async () => {
  const app = mount(true);
  try {
    app.sockets[0]!.receive({
      type: "call",
      call: {
        id: "synthetic-invite",
        status: "ringing",
        requestedBy: "operator",
        expiresAt: Date.now() + 60_000,
      },
    });
    expect(app.window.krispy?.isOpen()).toBe(true);
    expect(app.root.querySelector(".kcall-title")?.textContent).toBe("Incoming audio call");
    expect(app.sockets).toHaveLength(1);
    expect(app.fetches.some((url) => url.includes("/api/chat"))).toBe(false);
  } finally {
    app.window.dispatchEvent(new app.window.Event("pagehide"));
    void app.window.happyDOM.abort();
  }
});
