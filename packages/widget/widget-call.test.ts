import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./widget.js", import.meta.url), "utf8");
const start = source.indexOf("  var callState = null,");
const end = source.indexOf("  // ── live channel", start);
if (start < 0 || end < 0) throw new Error("widget call controller not found");

type Button = { textContent: string; disabled: boolean; click: () => void };
type Element = {
  textContent: string;
  children: Button[];
  classList: { add: (name: string) => void; remove: (name: string) => void };
  replaceChildren: () => void;
  appendChild: (child: Button) => void;
};
function element(): Element {
  return {
    textContent: "",
    children: [],
    classList: { add() {}, remove() {} },
    replaceChildren() {
      this.children = [];
    },
    appendChild(child) {
      this.children.push(child);
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness() {
  const callTitle = element(),
    callNote = element(),
    callControls = element();
  const callEl = element(),
    callAudio = element();
  const requests: { action: string; keepalive?: boolean }[] = [];
  const grant = deferred<{ clientUrl: string; url: string; token: string }>();
  const connect = deferred<void>();
  const micCalls: boolean[] = [];
  const rooms: FakeRoom[] = [];
  const listeners = new Map<string, () => void>();
  const document = {
    visibilityState: "visible",
    createElement: (_tag: string) => {
      const button: Button = { textContent: "", disabled: false, click() {} };
      return {
        ...button,
        addEventListener(_type: string, fn: () => void) {
          this.click = fn;
        },
      };
    },
  };
  class FakeRoom {
    remoteParticipants = new Map<string, object>();
    localParticipant = {
      setMicrophoneEnabled: (enabled: boolean) => {
        micCalls.push(enabled);
        return Promise.resolve();
      },
    };
    handlers = new Map<string, () => void>();
    disconnected = false;
    constructor() {
      rooms.push(this);
    }
    on(name: string, fn: () => void) {
      this.handlers.set(name, fn);
    }
    connect() {
      return connect.promise;
    }
    disconnect() {
      this.disconnected = true;
      this.handlers.get("disconnected")?.();
    }
    emit(name: string) {
      this.handlers.get(name)?.();
    }
  }
  const window = {
    LivekitClient: { Room: FakeRoom },
    addEventListener(name: string, fn: () => void) {
      listeners.set(name, fn);
    },
  };
  const fetch = (_url: string, options: { body: string; keepalive?: boolean }) => {
    const action = JSON.parse(options.body).action as string;
    requests.push({ action, keepalive: options.keepalive });
    if (action === "grant")
      return grant.promise.then((data) => ({ ok: true, json: () => Promise.resolve(data) }));
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ call: { id: "call-1", status: "ended" } }),
    });
  };
  // Evaluate the production call controller with narrow browser/LiveKit stubs.
  // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-type-assertion
  const factory = new Function(
    "cfg",
    "sessionId",
    "visitorSecret",
    "callEl",
    "callTitle",
    "callNote",
    "callControls",
    "callAudio",
    "document",
    "window",
    "fetch",
    `${source.slice(start, end)}; return { renderCall, joinCall, stopCallMedia };`,
  ) as (...args: unknown[]) => {
    renderCall: (call: { id: string; status: string }) => void;
    joinCall: (id: string) => Promise<void>;
    stopCallMedia: () => void;
  };
  const controller = factory(
    { api: "https://example.invalid", tenant: "test" },
    "session",
    "secret",
    callEl,
    callTitle,
    callNote,
    callControls,
    callAudio,
    document,
    window,
    fetch,
  );
  const click = (label: string) => {
    const button = callControls.children.find((item) => item.textContent === label);
    expect(button).toBeDefined();
    button!.click();
  };
  return {
    ...controller,
    callTitle,
    callNote,
    callControls,
    click,
    grant,
    connect,
    rooms,
    micCalls,
    requests,
    document,
    listeners,
  };
}
const accepted = { id: "call-1", status: "accepted" };
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("visitor audio call controller", () => {
  test("shows waiting until an operator joins and toggles the microphone", async () => {
    const app = harness();
    app.renderCall(accepted);
    app.click("Join call");
    app.click("End call"); // Ending while grant is pending prevents microphone access.
    app.grant.resolve({ clientUrl: "library", url: "room", token: "token" });
    await tick();
    expect(app.rooms).toHaveLength(0);
    expect(app.micCalls).toEqual([]);
  });

  test("room connection, remote arrival, and mute state are distinct", async () => {
    const app = harness();
    app.renderCall(accepted);
    const joining = app.joinCall("call-1");
    expect(
      app.callControls.children.filter((item) => item.textContent === "Join call"),
    ).toHaveLength(0);
    app.grant.resolve({ clientUrl: "library", url: "room", token: "token" });
    await tick();
    app.connect.resolve();
    await joining;
    expect(app.callTitle.textContent).toBe("Waiting for a team member");
    expect(app.callNote.textContent).toContain("Microphone on");
    app.rooms[0]!.remoteParticipants.set("operator", {});
    app.rooms[0]!.emit("participantConnected");
    expect(app.callTitle.textContent).toBe("Audio call connected");
    app.click("Mute");
    await tick();
    expect(app.micCalls).toEqual([true, false]);
    expect(app.callNote.textContent).toContain("Microphone off");
    app.click("Unmute");
    await tick();
    expect(app.micCalls).toEqual([true, false, true]);
    app.rooms[0]!.emit("reconnecting");
    expect(app.callTitle.textContent).toBe("Audio call reconnecting");
  });

  test("backgrounding during connect disconnects and ends the server call", async () => {
    const app = harness();
    app.renderCall(accepted);
    const joining = app.joinCall("call-1");
    app.grant.resolve({ clientUrl: "library", url: "room", token: "token" });
    for (let i = 0; i < 10 && !app.rooms.length; i++) await tick();
    expect(app.rooms).toHaveLength(1);
    app.document.visibilityState = "hidden";
    app.listeners.get("pagehide")?.();
    app.connect.resolve();
    await joining;
    expect(app.rooms[0]!.disconnected).toBe(true);
    expect(app.micCalls).toEqual([]);
    expect(app.requests).toContainEqual({ action: "end", keepalive: true });
  });
});
