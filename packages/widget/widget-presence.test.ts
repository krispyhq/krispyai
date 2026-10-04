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
  const fetches: { url: string; body?: string }[] = [];
  const fetch = async (url: string, init?: { body?: string }) => {
    fetches.push({ url, body: init?.body });
    return { ok: true, json: async () => ({ ok: true }) };
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
    await Promise.resolve();
    expect(app.sockets).toHaveLength(1);
    expect(app.sockets[0]!.url).toContain(
      `/api/session/${app.sessionId}/ws?t=tenant&v=${capability}`,
    );
    expect(app.fetches.some(({ url }) => url.includes("/api/chat"))).toBe(false);
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
    expect(app.sockets[0]!.readyState).toBe(1);
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

test("a reply chimes while the page is hidden, even with the chat open", async () => {
  const app = mount(true);
  // The chime is two notes, starting at 880 Hz; count those, not audio contexts
  // (the call ringtone also makes one when audio is unlocked).
  let chimes = 0;
  let contexts = 0;
  class FakeAudio {
    state = "running";
    currentTime = 0;
    destination = {};
    constructor() {
      contexts++;
    }
    resume() {}
    createOscillator() {
      const osc = {
        frequency: { value: 0 },
        connect: (n: unknown) => n,
        start() {
          if (osc.frequency.value === 880) chimes++;
        },
        stop() {},
      };
      return osc;
    }
    createGain() {
      const node = {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect: (n: unknown) => n,
      };
      return node;
    }
  }
  Object.defineProperty(app.window, "AudioContext", { configurable: true, value: FakeAudio });
  const setVisibility = (value: string) =>
    Object.defineProperty(app.window.document, "visibilityState", { configurable: true, value });
  const setFocus = (focused: boolean) =>
    Object.defineProperty(app.window.document, "hasFocus", {
      configurable: true,
      value: () => focused,
    });
  setFocus(true);
  try {
    await Promise.resolve();
    app.window.krispy?.open(); // opening counts as the interaction that unlocks audio
    app.sockets[0]!.receive({ type: "operator", text: "Seen right away", ts: 2_000 });
    expect(chimes).toBe(0); // open and visible: the reply is on screen, no sound
    // The visitor types (a gesture): the chime's audio is unlocked now, while the
    // page is in front. Browsers keep audio created later, from a hidden page with
    // no gesture, silent (Safari always; Chrome without an earlier click).
    app.window.document.dispatchEvent(new app.window.KeyboardEvent("keydown", { key: "a" }));
    const unlocked = contexts;
    setVisibility("hidden");
    app.sockets[0]!.receive({ type: "operator", text: "Waiting in another tab", ts: 3_000 });
    expect(chimes).toBe(1);
    expect(contexts).toBe(unlocked); // played on the unlocked audio, not a new one
    // Tab in front, but the browser window behind another app: the page still
    // reports visible, yet nobody is looking at it.
    setVisibility("visible");
    setFocus(false);
    app.sockets[0]!.receive({ type: "operator", text: "Window in the back", ts: 4_000 });
    expect(chimes).toBe(2);
  } finally {
    setVisibility("visible");
    app.window.dispatchEvent(new app.window.Event("pagehide"));
    void app.window.happyDOM.abort();
  }
});

test("a new visitor registers call presence when the page loads without opening chat", async () => {
  const app = mount(false);
  try {
    await Promise.resolve();
    expect(app.fetches.some(({ url }) => url.endsWith("/api/call/presence"))).toBe(true);
    expect(app.sockets).toHaveLength(1);
    expect(app.window.krispy?.isOpen()).toBe(false);
  } finally {
    void app.window.happyDOM.abort();
  }
});

test("an incoming invite still opens the closed chat panel on a restored page", async () => {
  const app = mount(true);
  try {
    await Promise.resolve();
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
    expect(app.fetches.some(({ url }) => url.includes("/api/chat"))).toBe(false);
  } finally {
    app.window.dispatchEvent(new app.window.Event("pagehide"));
    void app.window.happyDOM.abort();
  }
});

test("buffered receipt replay joins the opened chat in time order without duplicates", async () => {
  const app = mount(true);
  const receipt = {
    callId: "103218a5-c487-499f-b306-b7812f333f03",
    sessionId: app.sessionId,
    startedAt: 1_000,
    connectedAt: 1_100,
    connectedTimeProvenance: "signed_event",
    endedAt: 2_000,
    connectedDurationMs: 900,
    outcome: "ended",
    endTimeProvenance: "signed_event",
    revision: 1,
  };
  try {
    await Promise.resolve();
    app.sockets[0]!.receive({
      type: "ready",
      handoffState: "operator",
      messages: [{ role: "operator", text: "Later reply", ts: 3_000 }],
    });
    app.sockets[0]!.receive({ type: "call_receipt", receipt });
    expect(app.root.querySelectorAll(".callreceipt, .msg.op")).toHaveLength(0);
    app.window.krispy?.open();
    expect(
      Array.from(app.root.querySelectorAll(".callreceipt, .msg.op")).map((node) => node.className),
    ).toEqual(["callreceipt", "msg op"]);
    app.sockets[0]!.receive({ type: "call_receipt", receipt });
    expect(app.root.querySelectorAll(".callreceipt")).toHaveLength(1);
    const log = app.root.querySelector(".log")!;
    log.scrollTop = 11;
    app.sockets[0]!.receive({ type: "call_receipt", receipt: { ...receipt, revision: 2 } });
    expect(app.root.querySelectorAll(".callreceipt")).toHaveLength(1);
    expect(log.scrollTop).toBe(11);
  } finally {
    app.window.dispatchEvent(new app.window.Event("pagehide"));
    void app.window.happyDOM.abort();
  }
});
