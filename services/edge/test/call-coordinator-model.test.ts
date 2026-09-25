import { expect, test } from "bun:test";
import {
  acknowledgeCallOutbox,
  applyCallCommand,
  createCoordinatorState,
  expireCoordinatedCalls,
  operatorMayReceiveGrant,
  pruneCoordinatorState,
  waitingCalls,
  type CallCommand,
  type CoordinatorState,
  type VerifiedCallOperator,
} from "../src/call-coordinator-model";

const operator = (operatorId: string, deviceInstanceId: string, tenantId = "tenant") => ({
  tenantId,
  operatorId,
  deviceInstanceId,
});
const a1 = operator("a", "a-phone");
const a2 = operator("a", "a-tablet");
const b1 = operator("b", "b-phone");

function run(state: CoordinatorState, command: CallCommand) {
  return applyCallCommand(state, command);
}

function visitorCall(state: CoordinatorState, callId: string, now = 0) {
  return run(state, {
    type: "invite_visitor",
    callId,
    sessionId: `session-${callId}`,
    eventId: `invite-${callId}`,
    now,
  }).state;
}

function offer(state: CoordinatorState, callId: string, who: VerifiedCallOperator, now = 1) {
  return run(state, {
    type: "offer",
    callId,
    eventId: `offer-${callId}-${who.deviceInstanceId}`,
    now,
    operator: who,
  });
}

function accept(
  state: CoordinatorState,
  callId: string,
  who: VerifiedCallOperator,
  eventId: string,
  now = 2,
) {
  return run(state, { type: "accept_operator", callId, eventId, now, operator: who });
}

test("two simultaneous visitor requests reserve separate operators and bound the queue", () => {
  let state = createCoordinatorState("tenant", { maxPending: 2 });
  state = visitorCall(state, "one");
  state = visitorCall(state, "two", 1);
  expect(waitingCalls(state, 2).map((call) => call.callId)).toEqual(["one", "two"]);
  expect(
    run(state, { type: "invite_visitor", callId: "three", sessionId: "s3", eventId: "i3", now: 2 })
      .result.disposition,
  ).toBe("unavailable");
  state = offer(state, "one", a1).state;
  state = offer(state, "two", b1).state;
  expect(offer(state, "two", a2).result.disposition).toBe("operator_busy");
  state = accept(state, "one", a1, "a-accept").state;
  state = accept(state, "two", b1, "b-accept").state;
  expect(state.calls.one?.winner).toMatchObject({ operatorId: "a" });
  expect(state.calls.two?.winner).toMatchObject({ operatorId: "b" });
  state = visitorCall(state, "three", 3);
  expect(offer(state, "three", a2).result.disposition).toBe("operator_busy");
  expect(offer(state, "three", b1).result.disposition).toBe("operator_busy");
});

test("same user on two devices sees one winner; retries return its canonical current state", () => {
  let state = visitorCall(createCoordinatorState("tenant", { maxPending: 2 }), "one");
  state = offer(state, "one", a1).state;
  state = offer(state, "one", a2).state;
  const first = accept(state, "one", a1, "native-event-1");
  state = first.state;
  expect(first.result.disposition).toBe("accepted_self");
  expect(accept(state, "one", a2, "native-event-2").result.disposition).toBe("answered_elsewhere");
  expect(operatorMayReceiveGrant(state, "one", a1, 3)).toBe(true);
  expect(operatorMayReceiveGrant(state, "one", a2, 3)).toBe(false);
  expect(operatorMayReceiveGrant(state, "one", operator("a", "a-phone", "another-tenant"), 3)).toBe(
    false,
  );
  const outboxCount = Object.keys(state.outbox).length;
  const duplicate = accept(state, "one", a1, "native-event-1", 5);
  expect(duplicate.result.disposition).toBe("accepted_self");
  expect(duplicate.result.revision).toBe(state.calls.one!.revision);
  expect(Object.keys(duplicate.state.outbox)).toHaveLength(outboxCount);
  expect(accept(state, "one", a2, "native-event-1").result.disposition).toBe("unavailable");
});

test("a ringing offer reconciles as nonterminal and late native acceptance can release its claim", () => {
  let state = visitorCall(createCoordinatorState("tenant", { maxPending: 2 }), "one");
  state = offer(state, "one", a1).state;
  const reconciled = offer(state, "one", a1, 3);
  expect(reconciled.result).toMatchObject({ status: "ringing", disposition: "offered" });

  const accepted = accept(state, "one", a1, "native-accept", 4);
  state = accepted.state;
  expect(accepted.result.disposition).toBe("accepted_self");
  expect(
    run(state, {
      type: "end",
      callId: "one",
      eventId: "other-device-end",
      now: 5,
      actor: "operator",
      operator: a2,
    }).result.disposition,
  ).toBe("answered_elsewhere");
  // The native UI can time out before the HTTP answer arrives. Its late success
  // must trigger a fresh, idempotent End rather than joining the media room.
  const late = accept(state, "one", a1, "native-accept", 8);
  expect(late.result.disposition).toBe("accepted_self");
  const ended = run(state, {
    type: "end",
    callId: "one",
    eventId: "native-timeout-end",
    now: 9,
    actor: "operator",
    operator: a1,
  });
  state = ended.state;
  expect(ended.result).toMatchObject({ status: "ending", disposition: "completed_self" });
  expect(
    run(state, {
      type: "end",
      callId: "one",
      eventId: "other-device-ending-end",
      now: 10,
      actor: "operator",
      operator: a2,
    }).result.disposition,
  ).toBe("answered_elsewhere");
  expect(operatorMayReceiveGrant(state, "one", a1, 10)).toBe(false);
  expect(
    run(state, {
      type: "end",
      callId: "one",
      eventId: "native-timeout-end",
      now: 11,
      actor: "operator",
      operator: a1,
    }).result.disposition,
  ).toBe("completed_self");
  state = visitorCall(state, "two", 10);
  expect(offer(state, "two", a2).result.disposition).toBe("operator_busy");
  expect(Object.values(state.outbox).some((event) => event.kind === "close_room")).toBe(true);
});

test("acceptance stops losing device offers and dispatches the next queued request", () => {
  let state = createCoordinatorState("tenant", { maxPending: 2 });
  state = visitorCall(state, "one");
  state = visitorCall(state, "two", 1);
  state = offer(state, "one", a1).state;
  state = offer(state, "one", b1).state;
  state = accept(state, "one", a1, "winner", 2).state;
  expect(state.offers[a1.deviceInstanceId]).toBeUndefined();
  expect(state.offers[b1.deviceInstanceId]).toBeUndefined();
  expect(
    Object.values(state.outbox).some(
      (event) => event.kind === "stop_offer" && event.deviceInstanceId === a1.deviceInstanceId,
    ),
  ).toBe(false);
  expect(
    Object.values(state.outbox).some(
      (event) => event.kind === "stop_offer" && event.deviceInstanceId === b1.deviceInstanceId,
    ),
  ).toBe(true);
  expect(
    Object.values(state.outbox).some(
      (event) => event.kind === "dispatch" && event.callId === "two",
    ),
  ).toBe(true);
  expect(offer(state, "two", b1).result.disposition).toBe("offered");
  expect(offer(state, "two", a2).result.disposition).toBe("operator_busy");
  expect(accept(state, "one", b1, "late-loser").result.disposition).toBe("answered_elsewhere");
});

test("one device declining an offer leaves the other device and original deadline", () => {
  let state = visitorCall(createCoordinatorState("tenant", { maxPending: 2 }), "one");
  const originalDeadline = state.calls.one!.expiresAt;
  state = offer(state, "one", a1).state;
  state = offer(state, "one", a2).state;
  const declined = run(state, {
    type: "decline_offer",
    callId: "one",
    eventId: "decline-phone",
    now: 4,
    operator: a1,
  });
  state = declined.state;
  expect(declined.result.disposition).toBe("completed_self");
  expect(state.calls.one?.status).toBe("ringing");
  expect(state.offers[a1.deviceInstanceId]).toBeUndefined();
  expect(state.offers[a2.deviceInstanceId]).toBeDefined();
  expect(state.calls.one?.expiresAt).toBe(originalDeadline);
  state = run(state, {
    type: "decline_offer",
    callId: "one",
    eventId: "decline-tablet",
    now: 5,
    operator: a2,
  }).state;
  expect(state.calls.one?.status).toBe("waiting");
  expect(waitingCalls(state, 6).map((call) => call.callId)).toEqual(["one"]);
  expect(
    run(state, {
      type: "offer",
      callId: "one",
      eventId: "dispatch-phone-again",
      now: 7,
      operator: a1,
    }).result.disposition,
  ).toBe("unavailable");
  expect(
    run(state, {
      type: "offer",
      callId: "one",
      eventId: "dispatch-tablet-again",
      now: 7,
      operator: a2,
    }).result.disposition,
  ).toBe("unavailable");
  expect(offer(state, "one", b1, 7).result.disposition).toBe("offered");
});

test("only the initiating operator installation can cancel an outgoing ring", () => {
  let state = run(createCoordinatorState("tenant", { maxPending: 2 }), {
    type: "invite_operator",
    callId: "outgoing",
    sessionId: "session-outgoing",
    eventId: "invite-outgoing",
    now: 0,
    operator: a1,
  }).state;
  expect(
    run(state, {
      type: "cancel_operator",
      callId: "outgoing",
      eventId: "wrong-cancel",
      now: 2,
      operator: a2,
    }).result.disposition,
  ).toBe("answered_elsewhere");
  const canceled = run(state, {
    type: "cancel_operator",
    callId: "outgoing",
    eventId: "owner-cancel",
    now: 3,
    operator: a1,
  });
  state = canceled.state;
  expect(canceled.result).toMatchObject({ status: "canceled", disposition: "completed_self" });
  expect(state.calls.outgoing?.endedAt).toBe(3);
  expect(
    run(state, {
      type: "cancel_operator",
      callId: "outgoing",
      eventId: "late-start:native-start",
      now: 4,
      operator: a1,
    }).result,
  ).toMatchObject({ status: "canceled", disposition: "completed_self" });
  state = visitorCall(state, "incoming", 4);
  expect(offer(state, "incoming", a1, 5).result.disposition).toBe("offered");
});

test("visitor cancellation and offer expiry beat stale native answers", () => {
  let state = visitorCall(createCoordinatorState("tenant", { maxPending: 2 }), "one");
  state = offer(state, "one", a1).state;
  state = run(state, { type: "cancel_visitor", callId: "one", eventId: "cancel", now: 5 }).state;
  expect(accept(state, "one", a1, "late-answer").result.disposition).toBe("visitor_canceled");
  expect(operatorMayReceiveGrant(state, "one", a1, 6)).toBe(false);
  state = visitorCall(state, "two", 6);
  state = offer(state, "two", a1, 7).state;
  const expiry = state.calls.two!.expiresAt;
  state = expireCoordinatedCalls(state, expiry);
  expect(state.calls.two?.status).toBe("expired");
  expect(accept(state, "two", a1, "answer-after-expiry", expiry).result.disposition).toBe(
    "expired",
  );
  expect(state.offers[a1.deviceInstanceId]).toBeUndefined();
});

test("accepted call with lost response closes after join deadline and blocks reuse until media ends", () => {
  let state = visitorCall(
    createCoordinatorState("tenant", { maxPending: 2, joinWaitMs: 20 }),
    "one",
  );
  state = offer(state, "one", a1).state;
  state = accept(state, "one", a1, "lost-response", 2).state;
  state = visitorCall(state, "two", 3);
  expect(offer(state, "two", a2).result.disposition).toBe("operator_busy");
  expect(operatorMayReceiveGrant(state, "one", a1, 22)).toBe(false);
  expect(
    run(state, {
      type: "media_joined",
      callId: "one",
      eventId: "native-timeout-late-join",
      now: 22,
      operator: a1,
      source: "verified_room_query",
    }).result.disposition,
  ).toBe("unavailable");
  state = expireCoordinatedCalls(state, 22);
  expect(state.calls.one?.status).toBe("ending");
  expect(operatorMayReceiveGrant(state, "one", a1, 22)).toBe(false);
  expect(accept(state, "one", a1, "lost-response", 25).result).toMatchObject({
    disposition: "accepted_self",
    status: "ending",
  });
  expect(offer(state, "two", a1).result.disposition).toBe("operator_busy");
  const close = Object.values(state.outbox).find(
    (event) => event.kind === "close_room" && event.callId === "one",
  );
  expect(close).toBeDefined();
  expect(accept(state, "one", a1, "lost-response").state.outbox[close!.key]).toBeDefined();
  state = acknowledgeCallOutbox(state, close!.key);
  expect(state.outbox[close!.key]).toBeUndefined();
  state = run(state, {
    type: "media_ended",
    callId: "one",
    eventId: "livekit-ended",
    now: 26,
    source: "signed_room_finished",
  }).state;
  expect(state.calls.one?.status).toBe("ended");
  expect(offer(state, "two", a1).result.disposition).toBe("offered");
});

test("outgoing offer reserves one operator and revocation cancels it before media exists", () => {
  const initial = createCoordinatorState("tenant", { maxPending: 3 });
  const outgoing = run(initial, {
    type: "invite_operator",
    callId: "outgoing",
    sessionId: "s-out",
    eventId: "outgoing-intent",
    now: 0,
    operator: a1,
  });
  let state = visitorCall(outgoing.state, "incoming", 1);
  expect(offer(state, "incoming", a2).result.disposition).toBe("operator_busy");
  state = run(state, {
    type: "revoke_operator",
    operatorId: "a",
    eventId: "membership-revoked",
    now: 2,
  }).state;
  expect(state.calls.outgoing?.status).toBe("canceled");
  expect(offer(state, "incoming", a2).result.disposition).toBe("offered");
});

test("verified media join keeps the accepted call alive; revocation ends it safely", () => {
  let state = visitorCall(
    createCoordinatorState("tenant", { maxPending: 2, joinWaitMs: 20 }),
    "one",
  );
  state = offer(state, "one", a1).state;
  state = accept(state, "one", a1, "accept", 2).state;
  state = run(state, {
    type: "media_joined",
    callId: "one",
    eventId: "verified-join",
    now: 10,
    operator: a1,
    source: "verified_room_query",
  }).state;
  state = expireCoordinatedCalls(state, 22);
  expect(state.calls.one?.status).toBe("accepted");
  state = run(state, {
    type: "revoke_device",
    deviceInstanceId: a1.deviceInstanceId,
    eventId: "revoke",
    now: 23,
  }).state;
  expect(state.calls.one?.status).toBe("ending");
  expect(operatorMayReceiveGrant(state, "one", a1, 23)).toBe(false);
  state = visitorCall(state, "two", 24);
  expect(offer(state, "two", a2).result.disposition).toBe("operator_busy");
  state = run(state, {
    type: "media_ended",
    callId: "one",
    eventId: "room-closed",
    now: 25,
    source: "close_room_response",
  }).state;
  expect(offer(state, "two", a2).result.disposition).toBe("offered");
});

test("cross-tenant operator cannot receive an offer and failed projection stays in durable outbox", () => {
  let state = visitorCall(createCoordinatorState("tenant", { maxPending: 2 }), "one");
  const wrong = operator("a", "other-phone", "other-tenant");
  expect(offer(state, "one", wrong).result.disposition).toBe("unavailable");
  expect(Object.keys(state.offers)).toHaveLength(0);
  state = offer(state, "one", a1).state;
  const event = Object.values(state.outbox).find((item) => item.kind === "offer");
  expect(event).toBeDefined();
  const duplicate = offer(state, "one", a1);
  expect(duplicate.state.outbox[event!.key]).toBeDefined();
  state = acknowledgeCallOutbox(state, event!.key);
  expect(state.outbox[event!.key]).toBeUndefined();
});

test("retention removes only old terminal calls after their outbox is acknowledged", () => {
  const day = 24 * 60 * 60 * 1000;
  let state = visitorCall(createCoordinatorState("tenant", { maxPending: 2 }), "old", 0);
  state = run(state, {
    type: "cancel_visitor",
    callId: "old",
    eventId: "old-cancel",
    now: 10,
  }).state;
  state = visitorCall(state, "active", 11);
  const beforeAck = pruneCoordinatorState(state, 8 * day);
  expect(beforeAck.calls.old).toBeDefined();
  expect(beforeAck.receipts["old-cancel"]).toBeDefined();
  for (const event of Object.values(state.outbox)) {
    if (event.callId === "old") state = acknowledgeCallOutbox(state, event.key);
  }
  const pruned = pruneCoordinatorState(state, 8 * day);
  expect(pruned.calls.old).toBeUndefined();
  expect(pruned.receipts["old-cancel"]).toBeUndefined();
  expect(pruned.calls.active).toBeDefined();
  expect(pruned.receipts["invite-active"]).toBeDefined();
});

test("one durable timeline receipt uses verified connected duration and end-time provenance", () => {
  let state = visitorCall(createCoordinatorState("tenant", { maxPending: 2 }), "one", 0);
  state = offer(state, "one", a1, 1).state;
  state = accept(state, "one", a1, "answer", 2).state;
  state = run(state, {
    type: "media_joined",
    callId: "one",
    eventId: "both-present",
    now: 10,
    operator: a1,
    source: "verified_room_query",
  }).state;
  state = run(state, {
    type: "end",
    callId: "one",
    eventId: "end",
    now: 20,
    actor: "operator",
    operator: a1,
  }).state;
  state = run(state, {
    type: "media_ended",
    callId: "one",
    eventId: "room-finished",
    now: 30,
    occurredAt: 25,
    source: "signed_room_finished",
  }).state;
  expect(state.timelineReceipts.one).toMatchObject({
    callId: "one",
    sessionId: "session-one",
    startedAt: 0,
    connectedAt: 10,
    endedAt: 25,
    connectedDurationMs: 15,
    outcome: "ended",
    endTimeProvenance: "signed_event",
  });
  const receiptEvents = Object.values(state.outbox).filter((event) => event.kind === "receipt");
  expect(receiptEvents).toHaveLength(1);
  const duplicate = run(state, {
    type: "media_ended",
    callId: "one",
    eventId: "room-finished",
    now: 31,
    occurredAt: 25,
    source: "signed_room_finished",
  }).state;
  expect(duplicate.timelineReceipts.one).toEqual(state.timelineReceipts.one);
  expect(Object.values(duplicate.outbox).filter((event) => event.kind === "receipt")).toHaveLength(
    1,
  );
});

test("missed, declined, canceled, and recovered room end have distinct receipts", () => {
  let state = visitorCall(createCoordinatorState("tenant", { maxPending: 3 }), "missed", 0);
  state = expireCoordinatedCalls(state, state.calls.missed!.expiresAt);
  expect(state.timelineReceipts.missed).toMatchObject({
    outcome: "missed",
    connectedAt: null,
    connectedDurationMs: 0,
    endTimeProvenance: "server_transition",
  });
  state = run(state, {
    type: "invite_operator",
    callId: "declined",
    sessionId: "session-declined",
    eventId: "invite-declined",
    now: 1,
    operator: a1,
  }).state;
  state = run(state, {
    type: "decline_visitor",
    callId: "declined",
    eventId: "visitor-no",
    now: 2,
  }).state;
  expect(state.timelineReceipts.declined?.outcome).toBe("declined");
  state = visitorCall(state, "canceled", 3);
  state = run(state, {
    type: "cancel_visitor",
    callId: "canceled",
    eventId: "visitor-cancel",
    now: 4,
  }).state;
  expect(state.timelineReceipts.canceled?.outcome).toBe("canceled");
  state = visitorCall(state, "recovered", 5);
  state = offer(state, "recovered", a1, 6).state;
  state = accept(state, "recovered", a1, "recover-accept", 7).state;
  state = run(state, {
    type: "media_joined",
    callId: "recovered",
    eventId: "recover-connected",
    now: 8,
    operator: a1,
    source: "verified_room_query",
  }).state;
  state = run(state, {
    type: "media_ended",
    callId: "recovered",
    eventId: "room-absent",
    now: 12,
    source: "verified_room_absent",
  }).state;
  expect(state.timelineReceipts.recovered).toMatchObject({
    outcome: "ended",
    connectedDurationMs: 4,
    endTimeProvenance: "observed_room_absent",
  });
});
