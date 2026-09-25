import { expect, test } from "bun:test";
import worker from "../src/index";
import { SessionDO } from "../src/session-do";
import { DO_INTERNAL_HEADER, doInternalSecret } from "../src/store";
import type { Env } from "../src/types";
import type { CallState } from "../src/call";
import { CALL_MAX_DURATION_MS } from "../src/call";

const secretA = "a".repeat(43);
const secretB = "b".repeat(43);
const rtc = {
  LIVEKIT_URL: "wss://rtc.example.test",
  LIVEKIT_API_KEY: "test-key",
  LIVEKIT_API_SECRET: "test-secret",
  LIVEKIT_CLIENT_URL: "https://assets.example.test/livekit-client-v2.22.3.umd.min.js",
};

function harness(
  withRtc = true,
  visitorOnline = true,
  trigger: "always" | "after_handoff" = "always",
  enabled = true,
) {
  const objects = new Map<
    string,
    { instance: SessionDO; storage: Map<string, unknown>; state: DurableObjectState }
  >();
  const env = {
    TENANT_SYNC_SECRET: "trusted-test-sync",
    DO_INTERNAL_SECRET: "test-do-secret",
    KRISPY_KV: {
      get: async () =>
        JSON.stringify({
          callSettings: { enabled, visitorRequestsEnabled: true, visitorRequestTrigger: trigger },
        }),
      put: async () => {},
    },
    ...(withRtc ? rtc : {}),
    SESSION: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          let target = objects.get(name);
          if (!target) {
            const storage = new Map<string, unknown>();
            const state = {
              storage: {
                get: async (key: string) => storage.get(key),
                put: async (key: string, value: unknown) => {
                  storage.set(key, value);
                },
                list: async ({ prefix }: { prefix?: string } = {}) =>
                  new Map([...storage].filter(([key]) => !prefix || key.startsWith(prefix))),
                setAlarm: async (when: number | Date) => {
                  storage.set("__alarm", when instanceof Date ? when.getTime() : when);
                },
                deleteAlarm: async () => {
                  storage.delete("__alarm");
                },
                getAlarm: async () => storage.get("__alarm") ?? null,
              },
              getWebSockets: (tag?: string) =>
                tag === "call-visitor" && visitorOnline ? [{ send: () => {} }] : [],
            } as unknown as DurableObjectState;
            target = { instance: new SessionDO(state, env as Env), storage, state };
            objects.set(name, target);
          }
          return target.instance.fetch(input instanceof Request ? input : new Request(input, init));
        },
      }),
    },
  } as unknown as Env;
  const post = (
    route: string,
    body: object,
    authorized = false,
    ctx?: { waitUntil(promise: Promise<unknown>): void },
  ) =>
    worker.fetch(
      new Request(`https://edge.example.test${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorized ? { "x-tenant-sync-secret": env.TENANT_SYNC_SECRET! } : {}),
        },
        body: JSON.stringify(body),
      }),
      env,
      ctx,
    );
  const register = async (session: string, secret: string, tenant = "acme") => {
    const name = `${tenant}:${session}`;
    const stub = env.SESSION.get(env.SESSION.idFromName(name));
    return stub.fetch("https://do/call/visitor/register", {
      method: "POST",
      headers: { [DO_INTERNAL_HEADER]: doInternalSecret(env) },
      body: JSON.stringify({ secret }),
    });
  };
  return { env, post, register, objects };
}

const operator = (action: string, sessionId = "session-a", id?: string) => ({
  tenantId: "acme",
  sessionId,
  action,
  id,
});
const visitor = (
  action: string,
  sessionId = "session-a",
  visitorSecret = secretA,
  id?: string,
  nonce?: string,
) => ({ tenantId: "acme", sessionId, visitorSecret, action, id, nonce });

test("HTTP call routes reject absent RTC and unauthenticated operators", async () => {
  const absent = harness(false);
  expect((await absent.post("/api/operator/call", operator("invite"), true)).status).toBe(503);
  expect((await absent.post("/api/call", visitor("status"))).status).toBe(503);
  const ready = harness();
  expect((await ready.post("/api/operator/call", operator("invite"))).status).toBe(401);
  expect((await ready.post("/api/operator/call", operator("invite"), true)).status).toBe(409); // visitor has not registered
  const offline = harness(true, false);
  await offline.register("session-a", secretA);
  expect((await offline.post("/api/operator/call", operator("invite"), true)).status).toBe(409);
});

test("malformed call bodies fail with 400 before tenant or session lookup", async () => {
  const h = harness();
  const malformed: unknown[] = [
    null,
    [],
    { sessionId: 7, action: "invite" },
    { tenantId: {}, sessionId: "a", action: "invite" },
    { sessionId: "a", action: ["invite"] },
    { sessionId: "a", action: "invite", id: {} },
    { sessionId: "a", action: "invite", nonce: [] },
  ];
  for (const body of malformed) {
    const response = await h.post("/api/operator/call", body as object, true);
    expect(response.status).toBe(400);
  }
  expect(h.objects.size).toBe(0);
});

test("a grant being signed is rejected when its call ends and a new one is accepted", async () => {
  const h = harness();
  await h.register("session-a", secretA);
  const invite = await h.post("/api/operator/call", operator("invite"), true);
  const { call } = (await invite.json()) as { call: { id: string } };
  const status = await h.post("/api/call", visitor("status"));
  const { nonce } = (await status.json()) as { nonce: string };
  expect(
    (await h.post("/api/call", visitor("accept", "session-a", secretA, call.id, nonce))).status,
  ).toBe(200);

  const target = h.objects.get("acme:session-a")!;
  const realGet = target.state.storage.get.bind(target.state.storage);
  let reads = 0;
  let release!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const atRecheck = new Promise<void>((resolve) => {
    reached = resolve;
  });
  target.state.storage.get = async <T = unknown>(key: string) => {
    if (key === "call" && ++reads === 2) {
      reached();
      await paused;
    }
    return realGet<T>(key);
  };
  const pendingGrant = h.post("/api/call", visitor("grant", "session-a", secretA, call.id));
  await atRecheck;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;
    expect(
      (await h.post("/api/operator/call", operator("end", "session-a", call.id), true)).status,
    ).toBe(200);
    const replacement = await h.post("/api/operator/call", operator("invite"), true);
    const replacementId = ((await replacement.json()) as { call: { id: string } }).call.id;
    const replacementStatus = await h.post("/api/call", visitor("status"));
    const replacementNonce = ((await replacementStatus.json()) as { nonce: string }).nonce;
    expect(
      (
        await h.post(
          "/api/call",
          visitor("accept", "session-a", secretA, replacementId, replacementNonce),
        )
      ).status,
    ).toBe(200);
  } finally {
    globalThis.fetch = originalFetch;
    release();
  }
  expect((await pendingGrant).status).toBe(409);
});

test("HTTP+DO flow protects visitor nonce and session; late and ended calls cannot grant", async () => {
  const h = harness();
  expect((await h.register("session-a", secretA)).status).toBe(200);
  expect((await h.register("session-b", secretB)).status).toBe(200);
  const invited = await h.post("/api/operator/call", operator("invite"), true);
  expect(invited.status).toBe(200);
  const call = ((await invited.json()) as { call: { id: string; status: string } }).call;
  expect(call.status).toBe("ringing");
  const opStatus = await h.post("/api/operator/call", operator("status"), true);
  expect(await opStatus.json()).not.toHaveProperty("nonce");
  expect((await h.post("/api/call", visitor("status", "session-a", secretB))).status).toBe(403);
  expect(
    (await h.post("/api/call", visitor("accept", "session-b", secretB, call.id, "wrong"))).status,
  ).toBe(403);
  const vStatus = await h.post("/api/call", visitor("status"));
  const { nonce } = (await vStatus.json()) as { nonce: string };
  expect(nonce).toBeTruthy();
  expect(
    (await h.post("/api/call", visitor("accept", "session-a", secretA, call.id, "wrong"))).status,
  ).toBe(403);
  expect((await h.post("/api/call", visitor("grant", "session-a", secretA, call.id))).status).toBe(
    409,
  );
  expect(
    (await h.post("/api/call", visitor("accept", "session-a", secretA, call.id, nonce))).status,
  ).toBe(200);
  const grant = await h.post("/api/call", visitor("grant", "session-a", secretA, call.id));
  expect(grant.status).toBe(200);
  expect(((await grant.json()) as { token: string }).token.split(".")).toHaveLength(3);

  const originalFetch = globalThis.fetch;
  const deleted: string[] = [];
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      deleted.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
      expect(JSON.parse(init?.body as string)).toEqual({ room: `krispy-${call.id}` });
      return Response.json({});
    }) as typeof fetch;
    expect(
      (await h.post("/api/call", visitor("end", "session-a", secretA, call.id, nonce))).status,
    ).toBe(200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(deleted).toEqual(["/twirp/livekit.RoomService/DeleteRoom"]);
  expect((await h.post("/api/call", visitor("grant", "session-a", secretA, call.id))).status).toBe(
    409,
  );
  expect(
    (await h.post("/api/operator/call", operator("grant", "session-a", call.id), true)).status,
  ).toBe(409);

  const late = await h.post("/api/operator/call", operator("invite"), true);
  const lateCall = ((await late.json()) as { call: { id: string } }).call;
  const stored = h.objects.get("acme:session-a")!.storage.get("call") as CallState;
  h.objects.get("acme:session-a")!.storage.set("call", { ...stored, expiresAt: Date.now() - 1 });
  const lateStatus = await h.post("/api/call", visitor("status"));
  const lateNonce = ((await lateStatus.json()) as { nonce: string }).nonce;
  expect(
    (await h.post("/api/call", visitor("accept", "session-a", secretA, lateCall.id, lateNonce)))
      .status,
  ).toBe(409);
  expect(
    (await h.post("/api/call", visitor("grant", "session-a", secretA, lateCall.id))).status,
  ).toBe(409);
});

test("one DO alarm expires ringing calls and enforces active-call limit with room cleanup", async () => {
  const h = harness();
  await h.register("session-a", secretA);
  const first = await h.post("/api/operator/call", operator("invite"), true);
  const firstCall = ((await first.json()) as { call: { id: string; expiresAt: number } }).call;
  const target = h.objects.get("acme:session-a")!;
  expect(target.storage.get("__alarm")).toBe(firstCall.expiresAt);
  const ringing = target.storage.get("call") as CallState;
  target.storage.set("call", { ...ringing, expiresAt: Date.now() - 1 });
  await target.instance.alarm();
  expect((target.storage.get("call") as CallState).status).toBe("expired");
  expect(target.storage.has("__alarm")).toBe(false);

  const second = await h.post("/api/operator/call", operator("invite"), true);
  const secondCall = ((await second.json()) as { call: { id: string } }).call;
  const status = await h.post("/api/call", visitor("status"));
  const { nonce } = (await status.json()) as { nonce: string };
  await h.post("/api/call", visitor("accept", "session-a", secretA, secondCall.id, nonce));
  const accepted = target.storage.get("call") as CallState;
  expect(target.storage.get("__alarm")).toBe(accepted.acceptedAt! + CALL_MAX_DURATION_MS);
  target.storage.set("call", { ...accepted, acceptedAt: Date.now() - CALL_MAX_DURATION_MS - 1 });

  const originalFetch = globalThis.fetch;
  let attempts = 0;
  try {
    globalThis.fetch = (async () => {
      attempts++;
      return Response.json({ code: "unavailable" }, { status: 503 });
    }) as unknown as typeof fetch;
    await target.instance.alarm();
    expect((target.storage.get("call") as CallState).status).toBe("ended");
    expect(target.storage.get("callCleanupRoom")).toBe(accepted.room);
    expect(target.storage.get("__alarm")).toBeGreaterThan(Date.now());
    expect(
      (await h.post("/api/call", visitor("grant", "session-a", secretA, secondCall.id))).status,
    ).toBe(409);
    expect((await h.post("/api/operator/call", operator("invite"), true)).status).toBe(503);

    target.storage.set("callCleanupDueAt", Date.now() - 1);
    globalThis.fetch = (async () => {
      attempts++;
      return Response.json({});
    }) as unknown as typeof fetch;
    await target.instance.alarm();
    expect(target.storage.get("callCleanupRoom")).toBe("");
    expect(target.storage.has("__alarm")).toBe(false);
    expect(attempts).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("visitor requests need handoff by default; only the operator can accept", async () => {
  const h = harness(true, false, "after_handoff");
  await h.register("session-a", secretA);
  const before = await h.post("/api/call", visitor("status"));
  expect(((await before.json()) as { availableToRequest: boolean }).availableToRequest).toBe(false);
  expect((await h.post("/api/call", visitor("invite"))).status).toBe(409);
  expect(h.objects.get("acme:session-a")!.storage.has("call")).toBe(false);
  h.objects.get("acme:session-a")!.storage.set("handoffState", "pending");
  const status = await h.post("/api/call", visitor("status"));
  expect(((await status.json()) as { availableToRequest: boolean }).availableToRequest).toBe(true);
  const requested = await h.post("/api/call", visitor("invite"));
  expect(requested.status).toBe(200);
  const payload = (await requested.json()) as {
    call: { id: string; requestedBy: string };
    nonce: string;
  };
  expect(payload.call.requestedBy).toBe("visitor");
  expect(payload.nonce).toBeTruthy();
  expect(
    (await h.post("/api/operator/call", operator("status"), true).then((r) => r.json())) as object,
  ).not.toHaveProperty("nonce");
  expect(
    (
      await h.post(
        "/api/call",
        visitor("accept", "session-a", secretA, payload.call.id, payload.nonce),
      )
    ).status,
  ).toBe(403);
  expect(
    (await h.post("/api/operator/call", operator("cancel", "session-a", payload.call.id), true))
      .status,
  ).toBe(403);
  expect(
    (await h.post("/api/call", visitor("grant", "session-a", secretA, payload.call.id))).status,
  ).toBe(409);
  expect(
    (await h.post("/api/operator/call", operator("accept", "session-a", payload.call.id), true))
      .status,
  ).toBe(200);
  expect(h.objects.get("acme:session-a")!.storage.get("handoffState")).toBe("operator");
  expect(
    (await h.post("/api/call", visitor("grant", "session-a", secretA, payload.call.id))).status,
  ).toBe(200);
});

test("visitor cancellation and request rate limit do not take over the AI", async () => {
  const h = harness();
  await h.register("session-a", secretA);
  const first = await h.post("/api/call", visitor("invite"));
  const { call, nonce } = (await first.json()) as { call: { id: string }; nonce: string };
  expect((await h.post("/api/call", visitor("invite"))).status).toBe(200);
  expect(
    (await h.post("/api/call", visitor("cancel", "session-a", secretA, call.id, nonce))).status,
  ).toBe(200);
  expect(h.objects.get("acme:session-a")!.storage.get("handoffState")).toBeUndefined();
  expect(
    (
      (await (await h.post("/api/call", visitor("status"))).json()) as {
        availableToRequest: boolean;
      }
    ).availableToRequest,
  ).toBe(false);
  expect((await h.post("/api/call", visitor("invite"))).status).toBe(429);
});

test("disabled call setting hides invitations while preserving status", async () => {
  const h = harness(true, true, "always", false);
  await h.register("session-a", secretA);
  const status = await h.post("/api/call", visitor("status"));
  expect(await status.json()).toMatchObject({ available: false, availableToRequest: false });
  expect((await h.post("/api/call", visitor("invite"))).status).toBe(403);
  expect((await h.post("/api/operator/call", operator("invite"), true)).status).toBe(403);
});

test("a new visitor request pushes once with call metadata", async () => {
  const h = harness();
  await h.register("session-a", secretA);
  h.env.PUSH_TOKENS_URL = "https://push.example.test/tokens";
  const originalFetch = globalThis.fetch;
  const pushes: Array<{ title: string; data: { kind: string; callId: string } }> = [];
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("push.example.test"))
        return Response.json({ tokens: ["ExponentPushToken[test]"] });
      if (url.includes("exp.host")) {
        pushes.push(...JSON.parse(String(init?.body)));
        return Response.json({ data: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const first = await h.post("/api/call", visitor("invite"));
    expect(first.status).toBe(200);
    const id = ((await first.json()) as { call: { id: string } }).call.id;
    expect((await h.post("/api/call", visitor("invite"))).status).toBe(200);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      title: "Visitor requested a call",
      data: { kind: "call_request", callId: id },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("visitor invite responds before a delayed operator push and schedules it once", async () => {
  const h = harness();
  await h.register("session-a", secretA);
  h.env.PUSH_TOKENS_URL = "https://push.example.test/tokens";
  const originalFetch = globalThis.fetch;
  let releaseTokens!: () => void;
  const tokensReleased = new Promise<void>((resolve) => {
    releaseTokens = resolve;
  });
  const scheduled: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      scheduled.push(promise);
    },
  };
  const pushes: unknown[] = [];
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("push.example.test")) {
        await tokensReleased;
        return Response.json({ tokens: ["ExponentPushToken[test]"] });
      }
      if (url.includes("exp.host")) {
        pushes.push(...JSON.parse(String(init?.body)));
        return Response.json({ data: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const response = await Promise.race([
      h.post("/api/call", visitor("invite"), false, ctx),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("invite waited for push")), 2000),
      ),
    ]);
    expect(response.status).toBe(200);
    expect(scheduled).toHaveLength(1);
    expect(pushes).toHaveLength(0);
    expect((await h.post("/api/call", visitor("invite"), false, ctx)).status).toBe(200);
    expect(scheduled).toHaveLength(1);
    releaseTokens();
    await Promise.all(scheduled);
    expect(pushes).toHaveLength(1);
  } finally {
    releaseTokens();
    globalThis.fetch = originalFetch;
  }
});
