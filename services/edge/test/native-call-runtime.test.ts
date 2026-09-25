import { expect, test } from "bun:test";
import worker from "../src/index";
import { SessionDO } from "../src/session-do";
import { TenantCallCoordinatorDO } from "../src/tenant-call-do";
import { DO_INTERNAL_HEADER, doInternalSecret } from "../src/store";
import type { Env } from "../src/types";

const visitorSecret = "v".repeat(43);
const sessionId = "pilot-session";
const tenantId = "pilot-tenant";
const deviceInstanceId = "22222222-2222-4222-8222-222222222222";
const operatorId = "verified-operator";

function storage() {
  const values = new Map<string, unknown>();
  let queue = Promise.resolve();
  const api: DurableObjectStorage = {
    get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => void values.set(key, value),
    transaction: <T>(run: (tx: DurableObjectStorage) => Promise<T>) => {
      const work = queue.then(() => run(api));
      queue = work.then(
        () => undefined,
        () => undefined,
      );
      return work;
    },
    list: async <T = unknown>({ prefix }: { prefix?: string } = {}) =>
      new Map([...values].filter(([key]) => !prefix || key.startsWith(prefix))) as Map<string, T>,
    setAlarm: async (when: number | Date) => void values.set("__alarm", when),
    deleteAlarm: async () => void values.delete("__alarm"),
    getAlarm: async () => (values.get("__alarm") as number | null) ?? null,
  };
  return { values, api };
}

function fixture() {
  const sessions = new Map<string, { instance: SessionDO; values: Map<string, unknown> }>();
  const tenants = new Map<
    string,
    { instance: TenantCallCoordinatorDO; values: Map<string, unknown> }
  >();
  const frames: unknown[] = [];
  const env = {
    DO_INTERNAL_SECRET: "do-test-secret",
    TENANT_SYNC_SECRET: "cloud-to-edge-test",
    NATIVE_CALLS_ENABLED: "1",
    CALL_PILOT_TENANT_ID: tenantId,
    API_ORIGIN: "https://cloud.example.test",
    PUSH_TRIGGER_SECRET: "push-test-secret",
    LIVEKIT_URL: "wss://rtc.example.test",
    LIVEKIT_API_KEY: "test-key",
    LIVEKIT_API_SECRET: "test-secret",
    LIVEKIT_CLIENT_URL: "https://widget.example.test/vendor/livekit.js",
    KRISPY_KV: {
      get: async () =>
        JSON.stringify({
          callSettings: {
            enabled: true,
            visitorRequestsEnabled: true,
            visitorRequestTrigger: "always",
          },
        }),
      put: async () => undefined,
    },
    SESSION: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          let item = sessions.get(name);
          if (!item) {
            const store = storage();
            const state = {
              storage: store.api,
              getWebSockets: (tag?: string) =>
                tag === "call-visitor"
                  ? [{ send: (raw: string) => frames.push(JSON.parse(raw)) }]
                  : [],
            } as unknown as DurableObjectState;
            item = { instance: new SessionDO(state, env as Env), values: store.values };
            sessions.set(name, item);
          }
          return item.instance.fetch(input instanceof Request ? input : new Request(input, init));
        },
      }),
    },
    CALL_COORDINATOR: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          let item = tenants.get(name);
          if (!item) {
            const store = storage();
            const state = { storage: store.api } as unknown as DurableObjectState;
            item = {
              instance: new TenantCallCoordinatorDO(state, env as Env),
              values: store.values,
            };
            tenants.set(name, item);
          }
          return item.instance.fetch(input instanceof Request ? input : new Request(input, init));
        },
      }),
    },
  } as unknown as Env;
  const post = (path: string, body: object, auth = false) =>
    worker.fetch(
      new Request(`https://edge.example.test${path}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          ...(auth ? { "x-tenant-sync-secret": env.TENANT_SYNC_SECRET! } : {}),
        },
      }),
      env,
    );
  const internal = (path: string, body: object) =>
    post(`/api/internal/call-coordinator/${path}`, { tenantId, ...body }, true);
  const guest = (action: string, extra: object = {}) =>
    post("/api/call", { tenantId, sessionId, visitorSecret, action, ...extra });
  const register = async () => {
    const stub = env.SESSION.get(env.SESSION.idFromName(`${tenantId}:${sessionId}`));
    await stub.fetch("https://do/call/visitor/register", {
      method: "POST",
      headers: { [DO_INTERNAL_HEADER]: doInternalSecret(env) },
      body: JSON.stringify({ secret: visitorSecret }),
    });
    const session = sessions.get(`${tenantId}:${sessionId}`)!;
    session.values.set("tenantId", tenantId);
    session.values.set("sessionId", sessionId);
    session.values.set("siteId", "default");
  };
  return { env, post, internal, guest, register, sessions, tenants, frames };
}

test("guest accepts native outgoing call, grant is scoped, native End closes guest room through rollback", async () => {
  const f = fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/twirp/livekit.RoomService/DeleteRoom")) return Response.json({});
    if (url.endsWith("/status-changed")) return Response.json({ acknowledged: true });
    if (url.includes("/internal/native-calls/"))
      return Response.json({ delivered: true, devices: [] });
    return Response.json({ error: "unexpected" }, { status: 500 });
  }) as typeof fetch;
  try {
    await f.register();
    const start = await f.internal("start", {
      sessionId,
      operatorId,
      deviceInstanceId,
      actionEventId: "33333333-3333-4333-8333-333333333333",
    });
    expect(start.status).toBe(200);
    const started = (await start.json()) as { callId: string; status: string };
    expect(started.status).toBe("ringing");
    const status = (await (await f.guest("status")).json()) as {
      call: { id: string };
      nonce: string;
    };
    expect(status.call.id).toBe(started.callId);
    const accepted = await f.guest("accept", { id: started.callId, nonce: status.nonce });
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { call: { status: string } }).call.status).toBe("accepted");
    f.env.NATIVE_CALLS_ENABLED = "0"; // rollback blocks new calls, not owned grant/end
    const grant = await f.internal("grant", {
      sessionId,
      operatorId,
      deviceInstanceId,
      callId: started.callId,
    });
    expect(grant.status).toBe(200);
    expect((await grant.json()) as object).toMatchObject({
      callId: started.callId,
      livekitUrl: f.env.LIVEKIT_URL,
    });
    const end = await f.internal("action", {
      sessionId,
      operatorId,
      deviceInstanceId,
      callId: started.callId,
      actionEventId: "44444444-4444-4444-8444-444444444444",
      action: "end",
    });
    expect(end.status).toBe(200);
    const final = (await (await f.guest("status")).json()) as { call: { status: string } };
    expect(final.call.status).toBe("ended");
    expect(f.frames).toContainEqual(
      expect.objectContaining({ type: "call", call: expect.objectContaining({ status: "ended" }) }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("two native offers survive unrelated revisions; first winner invalidates the other", async () => {
  const f = fixture();
  const otherDevice = "33333333-3333-4333-8333-333333333333";
  const delivered: Array<{
    offerId: string;
    deviceInstanceId: string;
    revision: number;
    callId: string;
    expiresAt: number;
  }> = [];
  const invalidations: Array<{ revision: number; deviceInstanceIds: string[] }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/status-changed")) {
      invalidations.push(
        JSON.parse(String(init?.body)) as { revision: number; deviceInstanceIds: string[] },
      );
      return Response.json({ acknowledged: true });
    }
    if (url.endsWith("/eligible-devices"))
      return Response.json({
        devices: [
          { operatorId, deviceInstanceId, platform: "ios" },
          { operatorId, deviceInstanceId: otherDevice, platform: "ios" },
        ],
      });
    if (url.endsWith("/offer")) {
      const payload = JSON.parse(String(init?.body)) as (typeof delivered)[number] & {
        tenantId: string;
        operatorId: string;
      };
      const validity = await f.internal("offer-validity", payload);
      expect(validity.status).toBe(200);
      expect((await validity.json()) as object).toEqual({ valid: true });
      delivered.push(payload);
      return Response.json({ delivered: true });
    }
    if (url.endsWith("/stop-offer")) return Response.json({ stopped: true });
    return Response.json({ error: "unexpected" }, { status: 500 });
  }) as typeof fetch;
  try {
    await f.register();
    const invite = await f.guest("invite");
    expect(invite.status).toBe(200);
    const callId = ((await invite.json()) as { call: { id: string } }).call.id;
    expect(delivered).toHaveLength(2);
    expect(delivered[0]!.revision).toBeLessThan(delivered[1]!.revision);
    expect(invalidations.at(-1)?.deviceInstanceIds).toEqual([deviceInstanceId, otherDevice]);
    const firstAgain = await f.internal("offer-validity", {
      callId,
      operatorId,
      deviceInstanceId,
      offerId: delivered[0]!.offerId,
      expiresAt: delivered[0]!.expiresAt,
    });
    // Cloud already acknowledged this delivery, so the outbox key is consumed.
    expect((await firstAgain.json()) as object).toEqual({ valid: false });
    const accepted = await f.internal("action", {
      sessionId,
      operatorId,
      deviceInstanceId,
      callId,
      actionEventId: "44444444-4444-4444-8444-444444444444",
      action: "accept",
    });
    expect(accepted.status).toBe(200);
    expect(invalidations.at(-1)?.deviceInstanceIds).toEqual([deviceInstanceId, otherDevice]);
    const loser = await f.internal("offer-validity", {
      callId,
      operatorId,
      deviceInstanceId: otherDevice,
      offerId: delivered[1]!.offerId,
      expiresAt: delivered[1]!.expiresAt,
    });
    expect((await loser.json()) as object).toEqual({ valid: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an in-flight 0.4 room stays SessionDO-owned across pilot enable and rollback", async () => {
  const f = fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input).includes("/twirp/livekit.RoomService/DeleteRoom")
      ? Response.json({})
      : Response.json({ error: "unexpected" }, { status: 500 })) as typeof fetch;
  try {
    await f.register();
    f.env.NATIVE_CALLS_ENABLED = "0";
    const legacyInvite = await f.post(
      "/api/operator/call",
      {
        tenantId,
        sessionId,
        action: "invite",
      },
      true,
    );
    expect(legacyInvite.status).toBe(200);
    const legacyId = ((await legacyInvite.json()) as { call: { id: string } }).call.id;
    f.env.NATIVE_CALLS_ENABLED = "1";
    const nativeStart = await f.internal("start", {
      sessionId,
      operatorId,
      deviceInstanceId,
      actionEventId: "55555555-5555-4555-8555-555555555555",
    });
    expect(nativeStart.status).toBe(409);
    expect(f.tenants.size).toBe(0);
    const status = (await (await f.guest("status")).json()) as {
      call: { id: string };
      nonce: string;
    };
    expect(status.call.id).toBe(legacyId);
    f.env.NATIVE_CALLS_ENABLED = "0";
    const accepted = await f.guest("accept", { id: legacyId, nonce: status.nonce });
    expect(accepted.status).toBe(200);
    expect(
      ((await (await f.guest("status")).json()) as { call: { status: string } }).call.status,
    ).toBe("accepted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rebind cleanup stays 202 until the accepted room is proven closed", async () => {
  const f = fixture();
  let roomCloseSucceeds = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input).includes("/twirp/livekit.RoomService/DeleteRoom")
      ? Response.json({}, { status: roomCloseSucceeds ? 200 : 503 })
      : String(input).endsWith("/status-changed")
        ? Response.json({ acknowledged: true })
        : Response.json({ delivered: true, devices: [] })) as typeof fetch;
  try {
    await f.register();
    const started = (await (
      await f.internal("start", {
        sessionId,
        operatorId,
        deviceInstanceId,
        actionEventId: "66666666-6666-4666-8666-666666666666",
      })
    ).json()) as { callId: string };
    const guestStatus = (await (await f.guest("status")).json()) as { nonce: string };
    expect((await f.guest("accept", { id: started.callId, nonce: guestStatus.nonce })).status).toBe(
      200,
    );
    expect(
      (
        await f.internal("action", {
          sessionId,
          operatorId,
          deviceInstanceId,
          callId: started.callId,
          actionEventId: "77777777-7777-4777-8777-777777777777",
          action: "end",
        })
      ).status,
    ).toBe(200);
    const first = await f.internal("revoke-device", {
      deviceInstanceId,
      actionEventId: "rebind:88888888-8888-4888-8888-888888888888",
    });
    expect(first.status).toBe(202);
    expect((await first.json()) as object).toEqual({ cleanupConfirmed: false });
    roomCloseSucceeds = true;
    await f.tenants.get(tenantId)!.instance.alarm();
    const retry = await f.internal("revoke-device", {
      deviceInstanceId,
      actionEventId: "rebind:88888888-8888-4888-8888-888888888888",
    });
    expect(retry.status).toBe(200);
    expect((await retry.json()) as object).toEqual({ cleanupConfirmed: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("status invalidation remains durable until Cloud ack, even after flag-off rollback", async () => {
  const f = fixture();
  let signalReady = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input).endsWith("/status-changed")
      ? signalReady
        ? Response.json({ acknowledged: true })
        : Response.json({ error: "retry" }, { status: 503 })
      : Response.json({ delivered: true, devices: [] })) as typeof fetch;
  try {
    await f.register();
    expect(
      (
        await f.internal("start", {
          sessionId,
          operatorId,
          deviceInstanceId,
          actionEventId: "99999999-9999-4999-8999-999999999999",
        })
      ).status,
    ).toBe(200);
    const coordinator = f.tenants.get(tenantId)!;
    const stored = coordinator.values.get("coordinator:v1") as {
      outbox: Record<string, { kind: string }>;
    };
    expect(Object.values(stored.outbox).some((entry) => entry.kind === "status")).toBe(true);
    f.env.NATIVE_CALLS_ENABLED = "0";
    signalReady = true;
    await coordinator.instance.alarm();
    const after = coordinator.values.get("coordinator:v1") as {
      outbox: Record<string, { kind: string }>;
    };
    expect(Object.values(after.outbox).some((entry) => entry.kind === "status")).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("only LiveKit-confirmed two ACTIVE participants mark native media connected", async () => {
  const f = fixture();
  let bothActive = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/status-changed")) return Response.json({ acknowledged: true });
    if (url.endsWith("/ListParticipants")) {
      const state = f.tenants.get(tenantId)?.values.get("coordinator:v1") as
        | { calls: Record<string, { callId: string }> }
        | undefined;
      const id = Object.keys(state?.calls ?? {})[0];
      return Response.json({
        participants: bothActive
          ? [
              { identity: `operator-${id}`, state: 2 },
              { identity: `visitor-${id}`, state: "ACTIVE" },
            ]
          : [{ identity: `operator-${id}`, state: 1 }],
      });
    }
    return Response.json({ delivered: true, devices: [] });
  }) as typeof fetch;
  try {
    await f.register();
    const started = (await (
      await f.internal("start", {
        sessionId,
        operatorId,
        deviceInstanceId,
        actionEventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      })
    ).json()) as { callId: string };
    const status = (await (await f.guest("status")).json()) as { nonce: string };
    await f.guest("accept", { id: started.callId, nonce: status.nonce });
    const coordinator = f.tenants.get(tenantId)!;
    await coordinator.instance.alarm();
    let stored = coordinator.values.get("coordinator:v1") as {
      calls: Record<string, { mediaConnectedAt?: number; mediaStartProvenance?: string }>;
    };
    expect(stored.calls[started.callId]?.mediaConnectedAt).toBeUndefined();
    bothActive = true;
    await coordinator.instance.alarm();
    stored = coordinator.values.get("coordinator:v1") as typeof stored;
    expect(stored.calls[started.callId]?.mediaConnectedAt).toBeGreaterThan(0);
    expect(stored.calls[started.callId]?.mediaStartProvenance).toBe("observed_room_present");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
