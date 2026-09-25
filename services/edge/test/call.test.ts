import { expect, test } from "bun:test";
import {
  CALL_INVITE_TTL_MS,
  canJoinCall,
  currentCall,
  inviteCall,
  publicCall,
  transitionCall,
} from "../src/call";
import {
  CALL_TOKEN_TTL_SECONDS,
  callRtcAvailable,
  closeCallRoom,
  issueCallToken,
} from "../src/call-token";
import { SessionDO } from "../src/session-do";
import { DO_INTERNAL_HEADER, doInternalSecret } from "../src/store";
import type { Env } from "../src/types";

const now = 1_800_000_000_000;
const id = "84def37a-8ca6-4adb-82d5-22c29426e982";
const config = { url: "wss://rtc.example.test", apiKey: "test-key", apiSecret: "test-secret" };

function invited() {
  const result = inviteCall(null, now, id);
  if (!result.ok) throw new Error("expected invitation");
  return result.call;
}

test("invitation waits for explicit visitor acceptance before room access", () => {
  const call = invited();
  expect(call.status).toBe("ringing");
  expect(canJoinCall(call, id, now)).toBe(false);
  expect(publicCall(call, now)).not.toHaveProperty("room");
  const accepted = transitionCall(call, "accept", now + 1, id);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  expect(canJoinCall(accepted.call, id, now + 1)).toBe(true);
  expect(canJoinCall(accepted.call, "another-call", now + 1)).toBe(false);
});

test("decline, cancel, timeout, and end close the grant gate", () => {
  for (const action of ["decline", "cancel"] as const) {
    const result = transitionCall(invited(), action, now + 1, id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(canJoinCall(result.call, id, now + 1)).toBe(false);
  }
  const expired = currentCall(invited(), now + CALL_INVITE_TTL_MS);
  expect(expired?.status).toBe("expired");
  expect(transitionCall(expired, "accept", now + CALL_INVITE_TTL_MS, id)).toEqual({
    ok: false,
    reason: "expired",
  });
  const accepted = transitionCall(invited(), "accept", now + 1, id);
  if (!accepted.ok) throw new Error("expected acceptance");
  const ended = transitionCall(accepted.call, "end", now + 2, id);
  if (!ended.ok) throw new Error("expected end");
  expect(canJoinCall(ended.call, id, now + 2)).toBe(false);
});

test("duplicate invites and responses are idempotent; stale ID cannot mutate a new invitation", () => {
  const first = invited();
  const duplicate = inviteCall(first, now + 1, "another-id");
  expect(duplicate).toEqual({ ok: true, call: first, changed: false });
  const declined = transitionCall(first, "decline", now + 2, id);
  if (!declined.ok) throw new Error("expected decline");
  const repeated = transitionCall(declined.call, "decline", now + 3, id);
  expect(repeated.ok && repeated.changed).toBe(false);
  const next = inviteCall(declined.call, now + 4, "another-id");
  if (!next.ok) throw new Error("expected new invitation");
  expect(next.call.room).not.toBe(first.room);
  expect(transitionCall(next.call, "accept", now + 5, id)).toEqual({
    ok: false,
    reason: "no_invitation",
  });
});

test("token is short lived and scoped to one room, identity, and microphone only", async () => {
  const pending = invited();
  expect(await issueCallToken(config, pending, id, "visitor", now)).toBeNull();
  const accepted = transitionCall(pending, "accept", now + 1, id);
  if (!accepted.ok) throw new Error("expected acceptance");
  expect(await issueCallToken(config, accepted.call, "wrong-id", "visitor", now + 1)).toBeNull();
  const grant = await issueCallToken(config, accepted.call, id, "visitor", now + 1);
  expect(grant?.url).toBe(config.url);
  const [header, body, signature] = grant!.token.split(".");
  expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
    alg: "HS256",
    typ: "JWT",
  });
  const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
  expect(claims).toMatchObject({
    iss: config.apiKey,
    sub: `visitor-${id}`,
    video: {
      roomJoin: true,
      room: accepted.call.room,
      canPublish: true,
      canPublishSources: ["microphone"],
      canPublishData: false,
      canSubscribe: true,
      canUpdateOwnMetadata: false,
    },
  });
  expect(claims.exp - claims.iat).toBe(CALL_TOKEN_TTL_SECONDS);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(config.apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  expect(
    await crypto.subtle.verify(
      "HMAC",
      key,
      Buffer.from(signature!, "base64url"),
      new TextEncoder().encode(`${header}.${body}`),
    ),
  ).toBe(true);
  expect(claims).not.toHaveProperty("roomAdmin");
});

test("missing or insecure RTC configuration disables grants", async () => {
  const accepted = transitionCall(invited(), "accept", now + 1, id);
  if (!accepted.ok) throw new Error("expected acceptance");
  expect(callRtcAvailable({ url: "ws://public.example.test", apiKey: "a", apiSecret: "b" })).toBe(
    false,
  );
  expect(callRtcAvailable({ url: "ws://localhost:7880", apiKey: "a", apiSecret: "b" })).toBe(true);
  expect(
    await issueCallToken(
      { url: config.url, apiKey: config.apiKey },
      accepted.call,
      id,
      "visitor",
      now + 1,
    ),
  ).toBeNull();
});

test("room deletion calls LiveKit with a signed server grant and the exact room", async () => {
  let seen = false;
  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = true;
    expect(String(input)).toBe("https://rtc.example.test/twirp/livekit.RoomService/DeleteRoom");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ room: "private-room" });
    const headers = init?.headers as Record<string, string>;
    const payload = JSON.parse(
      Buffer.from(headers.authorization!.split(".")[1]!, "base64url").toString(),
    );
    expect(payload.video).toEqual({ roomCreate: true });
    return Response.json({});
  };
  expect(await closeCallRoom(config, "private-room", mockFetch)).toBe(true);
  expect(seen).toBe(true);
  expect(
    await closeCallRoom(config, "private-room", async () =>
      Response.json({ code: "not_found" }, { status: 404 }),
    ),
  ).toBe(true);
  expect(
    await closeCallRoom(
      config,
      "private-room",
      async () => new Response("wrong endpoint", { status: 404 }),
    ),
  ).toBe(false);
});

test("SessionDO keeps invitation nonce from operators and requires visitor capability", async () => {
  const storage = new Map<string, unknown>();
  const env = {
    DO_INTERNAL_SECRET: "test-do-secret",
    LIVEKIT_URL: config.url,
    LIVEKIT_API_KEY: config.apiKey,
    LIVEKIT_API_SECRET: config.apiSecret,
  } as Env;
  const state = {
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => {
        storage.set(key, value);
      },
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    },
    getWebSockets: (tag?: string) => (tag === "call-visitor" ? [{ send: () => {} }] : []),
  } as unknown as DurableObjectState;
  const instance = new SessionDO(state, env);
  const secret = "a".repeat(43);
  const baseHeaders = {
    [DO_INTERNAL_HEADER]: doInternalSecret(env),
    "content-type": "application/json",
  };
  const req = (path: string, body: object, headers: Record<string, string> = {}) =>
    instance.fetch(
      new Request(`https://do${path}`, {
        method: "POST",
        headers: { ...baseHeaders, ...headers },
        body: JSON.stringify(body),
      }),
    );
  expect((await req("/call/visitor/register", { secret })).status).toBe(200);
  const inviteResponse = await req("/call", { action: "invite" }, { "x-call-actor": "operator" });
  expect(inviteResponse.status).toBe(200);
  const { call } = (await inviteResponse.json()) as { call: { id: string; status: string } };
  expect(call.status).toBe("ringing");
  const opStatus = await instance.fetch(
    new Request("https://do/call", { headers: { ...baseHeaders, "x-call-actor": "operator" } }),
  );
  expect(await opStatus.json()).not.toHaveProperty("nonce");
  const denied = await req(
    "/call",
    { action: "accept", id: call.id },
    { "x-call-actor": "visitor", "x-call-visitor-secret": "b".repeat(43) },
  );
  expect(denied.status).toBe(403);
  const visitorStatus = await instance.fetch(
    new Request("https://do/call", {
      headers: { ...baseHeaders, "x-call-actor": "visitor", "x-call-visitor-secret": secret },
    }),
  );
  const { nonce } = (await visitorStatus.json()) as { nonce: string };
  expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
  expect(
    (
      await req(
        "/call",
        { action: "accept", id: call.id, nonce: "wrong" },
        { "x-call-actor": "visitor", "x-call-visitor-secret": secret },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await req(
        "/call",
        { action: "accept", id: call.id, nonce },
        { "x-call-actor": "visitor", "x-call-visitor-secret": secret },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await req(
        "/call/grant",
        { id: call.id },
        { "x-call-actor": "visitor", "x-call-visitor-secret": secret },
      )
    ).status,
  ).toBe(200);
  const fetchBeforeEnd = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;
    expect(
      (
        await req(
          "/call",
          { action: "end", id: call.id, nonce },
          { "x-call-actor": "visitor", "x-call-visitor-secret": secret },
        )
      ).status,
    ).toBe(200);
  } finally {
    globalThis.fetch = fetchBeforeEnd;
  }
  expect(
    (
      await req(
        "/call/grant",
        { id: call.id },
        { "x-call-actor": "visitor", "x-call-visitor-secret": secret },
      )
    ).status,
  ).toBe(409);
});
