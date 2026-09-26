import { expect, test } from "bun:test";
import { SessionDO } from "../src/session-do";
import { DO_INTERNAL_HEADER, doInternalSecret } from "../src/store";
import type { Env } from "../src/types";

const callId = "11111111-1111-4111-8111-111111111111";
const nextId = "22222222-2222-4222-8222-222222222222";
const secret = "a".repeat(43);

function fixture() {
  const data = new Map<string, unknown>([
    ["tenantId", "tenant"],
    ["sessionId", "session"],
    ["siteId", "default"],
    ["callVisitorSecret", secret],
  ]);
  const frames: unknown[] = [];
  let serial = Promise.resolve();
  const env = { DO_INTERNAL_SECRET: "internal-test" } as Env;
  const state = {
    storage: {
      get: async (key: string) => data.get(key),
      put: async (key: string, value: unknown) => void data.set(key, value),
      transaction: (run: (tx: DurableObjectStorage) => Promise<unknown>) => {
        const result = serial.then(() => run(state.storage));
        serial = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
      list: async () => new Map(),
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => null,
    },
    getWebSockets: () => [{ send: (raw: string) => frames.push(JSON.parse(raw)) }],
  } as unknown as DurableObjectState;
  const session = new SessionDO(state, env);
  const request = (
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    actor = "visitor",
    visitorSecret = secret,
  ) =>
    session.fetch(
      new Request(`https://do${path}`, {
        method,
        headers: {
          [DO_INTERNAL_HEADER]: doInternalSecret(env),
          "x-call-actor": actor,
          "x-call-visitor-secret": visitorSecret,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const claim = (
    id = callId,
    eventId = "guest-invite",
    actor: "visitor" | "operator" = "visitor",
  ) =>
    request(
      "/call/claim",
      "POST",
      {
        tenantId: "tenant",
        sessionId: "session",
        callId: id,
        eventId,
        requestedBy: actor,
      },
      actor,
    );
  return { data, frames, request, claim };
}

test("legacy accepted room remains owner; wrong visitor capability cannot claim", async () => {
  const f = fixture();
  f.data.set("call", {
    id: callId,
    room: `krispy-${callId}`,
    status: "accepted",
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
  });
  expect((await f.claim()).status).toBe(409);
  expect(f.data.get("callAuthority")).toBeUndefined();
  f.data.delete("call");
  const denied = await f.request(
    "/call/claim",
    "POST",
    {
      tenantId: "tenant",
      sessionId: "session",
      callId,
      eventId: "guest-invite",
      requestedBy: "visitor",
    },
    "visitor",
    "wrong",
  );
  expect(denied.status).toBe(403);
  f.data.set("callCleanupRoom", `krispy-${callId}`);
  expect((await f.claim()).status).toBe(409);
});

test("claim is idempotent, versioned, and rejects stale projections after a new call", async () => {
  const f = fixture();
  const first = (await (await f.claim()).json()) as { marker: { version: number; nonce: string } };
  expect(first.marker.version).toBe(1);
  const retry = (await (await f.claim()).json()) as {
    marker: { version: number; nonce: string };
    reused: boolean;
  };
  expect(retry.marker).toEqual(first.marker);
  expect(retry.reused).toBe(true);
  expect((await f.claim(nextId, "second-invite")).status).toBe(409);
  const claim = await f.request("/call/authority", "GET");
  expect((await claim.json()) as object).toMatchObject({
    owner: "coordinator",
    callId,
    ownerVersion: 1,
  });
  const projection = {
    callId,
    sessionId: "session",
    requestedBy: "visitor",
    status: "ringing",
    revision: 1,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  expect(
    (await f.request("/call/project", "POST", { callId, version: 1, call: projection })).status,
  ).toBe(200);
  const status = (await (await f.request("/call/authority", "GET")).json()) as {
    call: { status: string };
  };
  expect(status.call.status).toBe("ringing");
  expect(f.frames).toContainEqual(
    expect.objectContaining({ type: "call", call: expect.objectContaining({ id: callId }) }),
  );
  // A terminal projection releases the session slot but preserves this call's owner/version.
  expect(
    (
      await f.request("/call/project", "POST", {
        callId,
        version: 1,
        call: { ...projection, status: "expired", revision: 2, endedAt: Date.now() },
      })
    ).status,
  ).toBe(200);
  const second = (await (await f.claim(nextId, "second-invite", "operator")).json()) as {
    marker: { version: number };
  };
  expect(second.marker.version).toBe(2);
  expect(
    (
      await f.request("/call/project", "POST", {
        callId,
        version: 1,
        call: { ...projection, status: "accepted", revision: 3 },
      })
    ).status,
  ).toBe(409);
  expect(
    (await (await f.request(`/call/authority?id=${callId}`, "GET")).json()) as object,
  ).toMatchObject({ owner: "coordinator", ownerVersion: 1, callId });
});

test("a failed unprojected claim releases without weakening the next owner", async () => {
  const f = fixture();
  await f.claim();
  expect((await f.request("/call/release", "POST", { callId, version: 1 })).status).toBe(200);
  const second = (await (await f.claim(nextId, "second-invite", "operator")).json()) as {
    marker: { version: number };
  };
  expect(second.marker.version).toBe(2);
  expect((await f.request("/call/release", "POST", { callId, version: 1 })).status).toBe(409);
});
