import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./widget.js", import.meta.url), "utf8");
const start = source.indexOf("  var callState = null,");
const end = source.indexOf("  // ── live channel", start);
if (start < 0 || end < 0) throw new Error("widget call controller not found");

type Element = {
  textContent: string;
  children: Element[];
  disabled: boolean;
  hidden: boolean;
  value: string;
  attributes: Record<string, string>;
  click: () => void;
  change: () => void;
  setAttribute: (name: string, value: string) => void;
  addEventListener: (name: string, fn: () => void) => void;
  classList: { add: (name: string) => void; remove: (name: string) => void };
  replaceChildren: () => void;
  appendChild: (child: Element) => void;
};
function element(): Element {
  const listeners = new Map<string, () => void>();
  return {
    textContent: "",
    disabled: false,
    hidden: false,
    value: "",
    attributes: {},
    click: () => listeners.get("click")?.(),
    change: () => listeners.get("change")?.(),
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener: (name, fn) => listeners.set(name, fn),
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
function harness(
  outputSupported = true,
  storage = new Map<string, string>(),
  testSessionId = "session",
) {
  const callTitle = element(),
    callNote = element(),
    callControls = element();
  const callEl = element(),
    callExpand = element(),
    callDevices = element(),
    callAudio = element();
  const requests: { action: string; keepalive?: boolean }[] = [];
  const grant = deferred<{ clientUrl: string; url: string; token: string }>();
  const connect = deferred<void>();
  const micCalls: boolean[] = [];
  const deviceLookups: { kind: string; requestPermissions: boolean }[] = [];
  const deviceChanges: { kind: string; id: string }[] = [];
  const rooms: FakeRoom[] = [];
  const listeners = new Map<string, () => void>();
  const document = {
    visibilityState: "visible",
    createElement: (_tag: string) => element(),
  };
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };
  class FakeRoom {
    static getLocalDevices(kind: string, requestPermissions: boolean) {
      deviceLookups.push({ kind, requestPermissions });
      return Promise.resolve(
        kind === "audioinput"
          ? [
              { deviceId: "mic-1", label: "Built-in microphone" },
              { deviceId: "mic-2", label: "USB microphone" },
            ]
          : [
              { deviceId: "speaker-1", label: "Built-in speaker" },
              { deviceId: "speaker-2", label: "Headphones" },
            ],
      );
    }
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
    getActiveDevice(kind: string) {
      return kind === "audioinput" ? "mic-1" : "speaker-1";
    }
    switchActiveDevice(kind: string, id: string) {
      deviceChanges.push({ kind, id });
      return Promise.resolve(true);
    }
  }
  const window = {
    LivekitClient: { Room: FakeRoom, supportsAudioOutputSelection: () => outputSupported },
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
    "callExpand",
    "callTitle",
    "callNote",
    "callControls",
    "callDevices",
    "callAudio",
    "document",
    "window",
    "fetch",
    "localStorage",
    `var handoffChoices = null; function refreshHandoffChoices() {} function requestVisitorCall() {}; ${source.slice(start, end)}; return { renderCall, joinCall, stopCallMedia, noteHandoffOffer: typeof noteHandoffOffer === "function" ? noteHandoffOffer : function () {}, setCallOfferDismissed: typeof setCallOfferDismissed === "function" ? setCallOfferDismissed : function () {}, setCallAvailable: function () { callCanRequest = true; callVisitorConnected = true; } };`,
  ) as (...args: unknown[]) => {
    renderCall: (
      call: { id: string; status: string; requestedBy?: string; expiresAt?: number } | null,
    ) => void;
    joinCall: (id: string) => Promise<void>;
    stopCallMedia: () => void;
    setCallOfferDismissed: (dismissed: boolean) => void;
    noteHandoffOffer: (previousState: string, nextState: string) => void;
    setCallAvailable: () => void;
  };
  const controller = factory(
    { api: "https://example.invalid", tenant: "test", site: "course" },
    testSessionId,
    "secret",
    callEl,
    callExpand,
    callTitle,
    callNote,
    callControls,
    callDevices,
    callAudio,
    document,
    window,
    fetch,
    localStorage,
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
    callExpand,
    callDevices,
    click,
    grant,
    connect,
    rooms,
    micCalls,
    deviceLookups,
    deviceChanges,
    requests,
    document,
    listeners,
    storage,
  };
}
const accepted = { id: "call-1", status: "accepted" };
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("visitor audio call controller", () => {
  test("idle call offer dismisses across rerenders and reloads without touching a real invite", () => {
    const storage = new Map<string, string>();
    const app = harness(true, storage);
    app.setCallAvailable();
    app.renderCall(null);
    expect(app.callTitle.textContent).toBe("Speak with a team member");
    expect(app.callControls.children.map((item) => item.textContent)).toEqual([
      "Request a call",
      "Dismiss call offer",
    ]);
    app.click("Dismiss call offer");
    expect(app.requests).toEqual([]);
    app.renderCall(null);
    expect(app.callControls.children).toHaveLength(0);

    const reloaded = harness(true, storage);
    reloaded.setCallAvailable();
    reloaded.renderCall(null);
    expect(reloaded.callControls.children).toHaveLength(0);
    reloaded.renderCall({
      id: "operator-invite",
      status: "ringing",
      requestedBy: "operator",
      expiresAt: Date.now() + 60_000,
    });
    expect(reloaded.callTitle.textContent).toBe("Incoming audio call");
    expect(reloaded.callControls.children.map((item) => item.textContent)).toEqual([
      "Decline",
      "Accept",
    ]);
    expect(reloaded.requests).toEqual([]);
    reloaded.noteHandoffOffer("pending", "pending"); // repeated status is the same offer
    reloaded.renderCall(null);
    expect(reloaded.callControls.children).toHaveLength(0);
    reloaded.noteHandoffOffer("ai", "pending"); // a later explicit handoff starts a new offer
    reloaded.renderCall(null);
    expect(reloaded.callControls.children.map((item) => item.textContent)).toContain(
      "Request a call",
    );
    const newConversation = harness(true, storage, "new-session");
    newConversation.setCallAvailable();
    newConversation.renderCall(null);
    expect(newConversation.callControls.children.map((item) => item.textContent)).toContain(
      "Request a call",
    );
  });
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
    expect(app.joinCall("call-1")).toBe(joining);
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

  test("audio settings open only after Join and switch permitted devices without another prompt", async () => {
    const app = harness();
    app.renderCall(accepted);
    expect(app.callExpand.disabled).toBe(true);
    expect(app.deviceLookups).toEqual([]);
    const joining = app.joinCall("call-1");
    app.grant.resolve({ clientUrl: "library", url: "room", token: "token" });
    for (let i = 0; i < 10 && !app.rooms.length; i++) await tick();
    app.connect.resolve();
    await joining;
    expect(app.callExpand.disabled).toBe(false);
    app.click("Mute");
    app.callExpand.click();
    await tick();
    expect(app.callExpand.attributes["aria-expanded"]).toBe("true");
    expect(app.deviceLookups).toEqual([
      { kind: "audioinput", requestPermissions: false },
      { kind: "audiooutput", requestPermissions: false },
    ]);
    const microphone = app.callDevices.children[0]!.children[0]!;
    microphone.value = "mic-2";
    microphone.change();
    await tick();
    expect(app.deviceChanges).toEqual([{ kind: "audioinput", id: "mic-2" }]);
    expect(app.micCalls).toEqual([true, false]);
    expect(app.callControls.children.some((item) => item.textContent === "Unmute")).toBe(true);
    app.click("End call");
    expect(app.callDevices.hidden).toBe(true);
  });

  test("unsupported speaker selection stays hidden while microphone choices remain", async () => {
    const app = harness(false);
    app.renderCall(accepted);
    const joining = app.joinCall("call-1");
    app.grant.resolve({ clientUrl: "library", url: "room", token: "token" });
    for (let i = 0; i < 10 && !app.rooms.length; i++) await tick();
    app.connect.resolve();
    await joining;
    app.callExpand.click();
    await tick();
    expect(app.deviceLookups).toEqual([{ kind: "audioinput", requestPermissions: false }]);
    expect(app.callDevices.children.map((item) => item.textContent)).toContain("Microphone");
    expect(app.callDevices.children.map((item) => item.textContent)).not.toContain("Speaker");
  });

  test("a failed microphone update restores the control for retry", async () => {
    const app = harness();
    app.renderCall(accepted);
    const joining = app.joinCall("call-1");
    app.grant.resolve({ clientUrl: "library", url: "room", token: "token" });
    for (let i = 0; i < 10 && !app.rooms.length; i++) await tick();
    app.connect.resolve();
    await joining;
    const mic = deferred<void>();
    app.rooms[0]!.localParticipant.setMicrophoneEnabled = (enabled) => {
      app.micCalls.push(enabled);
      return mic.promise;
    };
    app.click("Mute");
    expect(
      app.callControls.children.find((item) => item.textContent === "Updating…")?.disabled,
    ).toBe(true);
    mic.reject(new Error("Microphone unavailable"));
    await tick();
    expect(app.callControls.children.some((item) => item.textContent === "Mute")).toBe(true);
    expect(app.callNote.textContent).toBe("Microphone unavailable");
  });

  test("a blocked microphone returns to Join with an actionable error", async () => {
    const app = harness();
    app.renderCall(accepted);
    app.click("Join call");
    app.grant.resolve({ clientUrl: "library", url: "room", token: "token" });
    for (let i = 0; i < 10 && !app.rooms.length; i++) await tick();
    const denied = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    app.rooms[0]!.localParticipant.setMicrophoneEnabled = () => Promise.reject(denied);
    app.connect.resolve();
    for (let i = 0; i < 10; i++) await tick();
    expect(app.rooms[0]!.disconnected).toBe(true);
    expect(app.callControls.children.some((item) => item.textContent === "Join call")).toBe(true);
    expect(app.callNote.textContent).toContain("Allow it for this site");
  });

  test("a connection failure returns to Join with a retry explanation", async () => {
    const app = harness();
    app.renderCall(accepted);
    app.click("Join call");
    app.grant.resolve({ clientUrl: "library", url: "room", token: "token" });
    for (let i = 0; i < 10 && !app.rooms.length; i++) await tick();
    app.connect.reject(new Error("connection failed"));
    for (let i = 0; i < 10; i++) await tick();
    expect(app.rooms[0]!.disconnected).toBe(true);
    expect(app.callControls.children.some((item) => item.textContent === "Join call")).toBe(true);
    expect(app.callNote.textContent).toContain("Check your connection");
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
