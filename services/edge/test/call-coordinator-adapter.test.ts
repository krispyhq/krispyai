import { expect, test } from "bun:test";
import {
  applyOperatorCoordinatorAction,
  applyVerifiedRoomClosure,
  configuredCallFallback,
  type CoordinatorBoundary,
  type CoordinatorStorage,
} from "../src/call-coordinator-adapter";
import { applyCallCommand, createCoordinatorState } from "../src/call-coordinator-model";

const callId = "11111111-1111-4111-8111-111111111111";
const sessionId = "opaque-session";
const operator = { tenantId: "tenant", operatorId: "verified-user", deviceInstanceId: "phone" };

function fixture() {
  let state = applyCallCommand(createCoordinatorState("tenant", { maxPending: 2 }), {
    type: "invite_visitor",
    callId,
    sessionId,
    eventId: "visitor-invite",
    now: 0,
  }).state;
  state = applyCallCommand(state, {
    type: "offer",
    callId,
    eventId: "server-offer",
    now: 1,
    operator,
  }).state;
  let writes = 0;
  const storage: CoordinatorStorage = {
    transaction: async (run) =>
      run({
        get: async () => state,
        put: async (_key, value) => {
          state = value;
          writes++;
        },
      }),
  };
  const boundary: CoordinatorBoundary = {
    verifyOperator: async () => ({ operator, expiresAt: 100 }),
    verifySystemEvent: async () => true,
    verifyRoomClosed: async () => false,
  };
  return { storage, boundary, state: () => state, writes: () => writes };
}

test("operator adapter validates IDs and uses verified identity, never body actor", async () => {
  const f = fixture();
  const request = new Request("https://example.invalid/native-call");
  const body = {
    action: "accept",
    callId,
    sessionId,
    eventId: "22222222-2222-4222-8222-222222222222",
    operatorId: "attacker",
    deviceInstanceId: "other",
  };
  expect(
    await applyOperatorCoordinatorAction(
      f.storage,
      f.boundary,
      request,
      { ...body, callId: "../bad" },
      "tenant",
      2,
    ),
  ).toMatchObject({ ok: false, status: 400 });
  expect(
    await applyOperatorCoordinatorAction(
      f.storage,
      f.boundary,
      request,
      { ...body, sessionId: "wrong" },
      "tenant",
      2,
    ),
  ).toMatchObject({ ok: false, status: 404 });
  expect(
    await applyOperatorCoordinatorAction(f.storage, f.boundary, request, body, "other-tenant", 2),
  ).toMatchObject({ ok: false, status: 403 });
  const otherDevice: CoordinatorBoundary = {
    ...f.boundary,
    verifyOperator: async () => ({
      operator: { ...operator, deviceInstanceId: "other-phone" },
      expiresAt: 100,
    }),
  };
  expect(
    await applyOperatorCoordinatorAction(
      f.storage,
      otherDevice,
      request,
      { ...body, eventId: "wrong-device-attempt" },
      "tenant",
      2,
    ),
  ).toMatchObject({ ok: true, receipt: { disposition: "unavailable" } });
  const accepted = await applyOperatorCoordinatorAction(
    f.storage,
    f.boundary,
    request,
    body,
    "tenant",
    2,
  );
  expect(accepted).toMatchObject({
    ok: true,
    receipt: { status: "accepted", disposition: "accepted_self" },
  });
  expect(f.state().calls[callId]?.winner).toEqual({
    operatorId: "verified-user",
    deviceInstanceId: "phone",
  });
  expect(f.writes()).toBe(1);
});

test("expired or revoked auth fails before storage and room closure needs independent proof", async () => {
  const f = fixture();
  const request = new Request("https://example.invalid/native-call");
  const body = { action: "accept", callId, sessionId, eventId: "native-accept" };
  const expired: CoordinatorBoundary = {
    ...f.boundary,
    verifyOperator: async () => ({ operator, expiresAt: 2 }),
  };
  expect(
    await applyOperatorCoordinatorAction(f.storage, expired, request, body, "tenant", 2),
  ).toMatchObject({ ok: false, status: 401 });
  const revoked: CoordinatorBoundary = { ...f.boundary, verifyOperator: async () => null };
  expect(
    await applyOperatorCoordinatorAction(f.storage, revoked, request, body, "tenant", 2),
  ).toMatchObject({ ok: false, status: 401 });
  expect(f.writes()).toBe(0);
  await applyOperatorCoordinatorAction(f.storage, f.boundary, request, body, "tenant", 2);
  await applyOperatorCoordinatorAction(
    f.storage,
    f.boundary,
    request,
    { action: "end", callId, sessionId, eventId: `unsafe-stop:${callId}` },
    "tenant",
    3,
  );
  expect(f.state().calls[callId]?.status).toBe("ending");
  expect(
    await applyVerifiedRoomClosure(
      f.storage,
      f.boundary,
      request,
      "tenant",
      callId,
      "room-proof",
      { source: "client-claim" },
      4,
    ),
  ).toMatchObject({ ok: false, status: 409 });
  expect(f.state().calls[callId]?.status).toBe("ending");
  const verified: CoordinatorBoundary = { ...f.boundary, verifyRoomClosed: async () => true };
  const untrusted: CoordinatorBoundary = { ...verified, verifySystemEvent: async () => false };
  expect(
    await applyVerifiedRoomClosure(
      f.storage,
      untrusted,
      request,
      "tenant",
      callId,
      "untrusted-event",
      {},
      5,
    ),
  ).toMatchObject({ ok: false, status: 401 });
  expect(
    await applyVerifiedRoomClosure(
      f.storage,
      verified,
      request,
      "other-tenant",
      callId,
      "wrong-tenant-proof",
      {},
      5,
    ),
  ).toMatchObject({ ok: false, status: 404 });
  expect(
    await applyVerifiedRoomClosure(
      f.storage,
      verified,
      request,
      "tenant",
      callId,
      "room-proof",
      { signed: true },
      5,
    ),
  ).toMatchObject({ ok: true, receipt: { status: "ended" } });
});

test("timeout fallback contains only configured public forms and links", () => {
  expect(configuredCallFallback(null)).toMatchObject({
    fallbackAvailable: false,
    forms: [],
    ctas: [],
  });
  const configured = configuredCallFallback({
    forms: [
      {
        id: "contact",
        title: "Leave details",
        fields: [{ name: "phone", label: "Phone", type: "tel" }],
      },
    ],
    connectors: [
      { id: "mail", type: "email", toAddress: "owner@example.com" },
      { id: "ig", type: "instagram", profileUrl: "https://instagram.com/example" },
    ],
  });
  expect(configured.fallbackAvailable).toBe(true);
  expect(configured.forms.map((form) => form.id)).toEqual(["contact"]);
  expect(configured.ctas.map((cta) => cta.id)).toEqual(["ig"]);
});
