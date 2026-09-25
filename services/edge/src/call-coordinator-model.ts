import { CALL_INVITE_TTL_MS, CALL_MAX_DURATION_MS } from "./call";

/** A tenant-scoped coordinator owns these states; SessionDO only mirrors them. */
export type CoordinatedCallStatus =
  | "waiting"
  | "ringing"
  | "accepted"
  | "ending"
  | "ended"
  | "declined"
  | "canceled"
  | "expired";

export type CallDisposition =
  | "queued"
  | "offered"
  | "accepted_self"
  | "completed_self"
  | "answered_elsewhere"
  | "operator_busy"
  | "visitor_canceled"
  | "expired"
  | "unavailable";

export interface VerifiedCallOperator {
  /** The API or trusted proxy resolves these; the browser never chooses operatorId. */
  tenantId: string;
  operatorId: string;
  /** Bound to this authenticated operator at token registration. */
  deviceInstanceId: string;
}

export interface CoordinatedCall {
  callId: string;
  sessionId: string;
  requestedBy: "visitor" | "operator";
  status: CoordinatedCallStatus;
  createdAt: number;
  expiresAt: number;
  revision: number;
  acceptedAt?: number;
  /** Accepted-but-never-joined calls close after this deadline. */
  joinDueAt?: number;
  /** Set only after the server verifies BOTH LiveKit participants present. */
  mediaConnectedAt?: number;
  mediaStartProvenance?: "signed_event" | "observed_room_present";
  /** Verified media end; may precede a delayed room-cleanup confirmation. */
  mediaDisconnectedAt?: number;
  mediaEndProvenance?: "signed_event" | "observed_room_absent" | "confirmed_room_delete";
  endedAt?: number;
  /** Outgoing calls reserve their operator before the visitor answers. */
  outgoingBy?: Pick<VerifiedCallOperator, "operatorId" | "deviceInstanceId">;
  /** Keep this claim through `ending` until room termination is confirmed. */
  winner?: Pick<VerifiedCallOperator, "operatorId" | "deviceInstanceId">;
  /** A declined/revoked offer must not be sent back to the same target. */
  ineligibleDevices?: string[];
  ineligibleOperators?: string[];
}

export interface CallOffer {
  callId: string;
  operatorId: string;
  deviceInstanceId: string;
}

export interface CallReceipt {
  callId: string;
  status: CoordinatedCallStatus | null;
  expiresAt: number | null;
  revision: number | null;
  disposition: CallDisposition;
}

/** Durable, content-free transcript record; never derived from accept time. */
export interface CallTimelineReceipt {
  callId: string;
  sessionId: string;
  startedAt: number;
  connectedAt: number | null;
  connectedTimeProvenance: "signed_event" | "observed_room_present" | null;
  endedAt: number;
  connectedDurationMs: number;
  outcome: "ended" | "missed" | "declined" | "canceled";
  endTimeProvenance:
    | "signed_event"
    | "observed_room_absent"
    | "confirmed_room_delete"
    | "server_transition";
  revision: number;
}

const CALL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validCallTime = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 8_640_000_000_000_000;

export function isCallTimelineReceipt(value: unknown): value is CallTimelineReceipt {
  if (!value || typeof value !== "object") return false;
  const fields = new Map<string, unknown>(Object.entries(value));
  const callId = fields.get("callId");
  const sessionId = fields.get("sessionId");
  const connectedAt = fields.get("connectedAt");
  const startedAt = fields.get("startedAt");
  const endedAt = fields.get("endedAt");
  const duration = fields.get("connectedDurationMs");
  const startSource = fields.get("connectedTimeProvenance");
  const outcome = fields.get("outcome");
  const revision = fields.get("revision");
  return (
    typeof callId === "string" &&
    CALL_UUID.test(callId) &&
    typeof sessionId === "string" &&
    sessionId.length > 0 &&
    sessionId.length <= 200 &&
    validCallTime(startedAt) &&
    (connectedAt === null || validCallTime(connectedAt)) &&
    validCallTime(endedAt) &&
    startedAt <= endedAt &&
    (connectedAt === null || (connectedAt >= startedAt && connectedAt <= endedAt)) &&
    (connectedAt === null
      ? startSource === null
      : ["signed_event", "observed_room_present"].includes(String(startSource))) &&
    typeof duration === "number" &&
    Number.isFinite(duration) &&
    duration >= 0 &&
    (connectedAt === null ? duration === 0 : duration === endedAt - connectedAt) &&
    ["ended", "missed", "declined", "canceled"].includes(String(outcome)) &&
    (connectedAt === null ? outcome !== "ended" : outcome === "ended") &&
    ["signed_event", "observed_room_absent", "confirmed_room_delete", "server_transition"].includes(
      String(fields.get("endTimeProvenance")),
    ) &&
    typeof revision === "number" &&
    Number.isInteger(revision) &&
    revision > 0
  );
}

export interface CallOutboxEvent {
  key: string;
  kind: "status" | "offer" | "stop_offer" | "close_room" | "dispatch" | "receipt";
  callId: string;
  revision: number;
  deviceInstanceId?: string;
}

export interface CoordinatorState {
  tenantId: string;
  /** Exact per-tenant capacity; the eventual tenant setting chooses its value. */
  maxPending: number;
  waitMs: number;
  joinWaitMs: number;
  calls: Record<string, CoordinatedCall>;
  offers: Record<string, CallOffer>;
  /** Keyed by native actionEventId; stored durably with the state by the future DO. */
  receipts: Record<string, { fingerprint: string; result: CallReceipt; createdAt: number }>;
  /** Projection is retried until SessionDO stores each callId outside the chat ring. */
  timelineReceipts: Record<string, CallTimelineReceipt>;
  /** Retried until acknowledged; no push or projection is considered a transaction. */
  outbox: Record<string, CallOutboxEvent>;
}

export type CallCommand =
  | { type: "invite_visitor"; callId: string; sessionId: string; eventId: string; now: number }
  | {
      type: "invite_operator";
      callId: string;
      sessionId: string;
      eventId: string;
      now: number;
      operator: VerifiedCallOperator;
    }
  | {
      type: "offer";
      callId: string;
      eventId: string;
      now: number;
      operator: VerifiedCallOperator;
    }
  | {
      type: "accept_operator" | "decline_offer";
      callId: string;
      eventId: string;
      now: number;
      operator: VerifiedCallOperator;
    }
  | {
      type: "cancel_operator";
      callId: string;
      eventId: string;
      now: number;
      operator: VerifiedCallOperator;
    }
  | {
      type: "accept_visitor" | "decline_visitor" | "cancel_visitor";
      callId: string;
      eventId: string;
      now: number;
    }
  | {
      type: "end";
      callId: string;
      eventId: string;
      now: number;
      actor: "visitor" | "operator";
      operator?: VerifiedCallOperator;
    }
  | {
      type: "media_ended";
      callId: string;
      eventId: string;
      now: number;
      /** Occupancy releases only after the whole room is proven closed. */
      source: "signed_room_finished" | "verified_room_absent" | "close_room_response";
      /** Verified event time; omitted for a room-query observation. */
      occurredAt?: number;
    }
  | {
      type: "media_joined";
      callId: string;
      eventId: string;
      now: number;
      operator: VerifiedCallOperator;
      /** An authenticated client intent alone is insufficient. */
      source: "signed_livekit_event" | "verified_room_query";
      /** Signed time of verified two-party presence, when available. */
      occurredAt?: number;
    }
  | { type: "revoke_device"; deviceInstanceId: string; eventId: string; now: number }
  | { type: "revoke_operator"; operatorId: string; eventId: string; now: number };

export const defaultCallWaitMs = CALL_INVITE_TTL_MS;
export const DEFAULT_CALL_JOIN_WAIT_MS = 30_000;
export const DEFAULT_CALL_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function excludeDevice(call: CoordinatedCall, deviceId: string): void {
  if (!call.ineligibleDevices?.includes(deviceId))
    call.ineligibleDevices = [...(call.ineligibleDevices ?? []), deviceId];
}

function excludeOperator(call: CoordinatedCall, operatorId: string): void {
  if (!call.ineligibleOperators?.includes(operatorId))
    call.ineligibleOperators = [...(call.ineligibleOperators ?? []), operatorId];
}

export function createCoordinatorState(
  tenantId: string,
  options: { maxPending: number; waitMs?: number; joinWaitMs?: number },
): CoordinatorState {
  if (!tenantId || !Number.isInteger(options.maxPending) || options.maxPending < 1)
    throw new Error("invalid coordinator capacity");
  const waitMs = options.waitMs ?? defaultCallWaitMs;
  if (!Number.isFinite(waitMs) || waitMs <= 0) throw new Error("invalid call wait");
  const joinWaitMs = options.joinWaitMs ?? DEFAULT_CALL_JOIN_WAIT_MS;
  if (!Number.isFinite(joinWaitMs) || joinWaitMs <= 0) throw new Error("invalid join wait");
  return {
    tenantId,
    maxPending: options.maxPending,
    waitMs,
    joinWaitMs,
    calls: {},
    offers: {},
    receipts: {},
    timelineReceipts: {},
    outbox: {},
  };
}

function receipt(
  call: CoordinatedCall | undefined,
  disposition: CallDisposition,
  callId: string,
): CallReceipt {
  return {
    callId,
    status: call?.status ?? null,
    expiresAt: call?.expiresAt ?? null,
    revision: call?.revision ?? null,
    disposition,
  };
}

function emit(
  state: CoordinatorState,
  call: CoordinatedCall,
  kind: CallOutboxEvent["kind"],
  deviceInstanceId?: string,
): void {
  const key = `${call.callId}:${call.revision}:${kind}:${deviceInstanceId ?? ""}`;
  state.outbox[key] = {
    key,
    kind,
    callId: call.callId,
    revision: call.revision,
    ...(deviceInstanceId ? { deviceInstanceId } : {}),
  };
}

function removeOffers(
  state: CoordinatorState,
  call: CoordinatedCall,
  winningDeviceInstanceId?: string,
): void {
  for (const [deviceId, offer] of Object.entries(state.offers)) {
    if (offer.callId !== call.callId) continue;
    delete state.offers[deviceId];
    if (deviceId !== winningDeviceInstanceId) emit(state, call, "stop_offer", deviceId);
  }
}

function dispatchNextWaiting(state: CoordinatorState, now: number): void {
  const next = waitingCalls(state, now)[0];
  if (next) emit(state, next, "dispatch");
}

function operatorBusy(state: CoordinatorState, operatorId: string, exceptCallId?: string): boolean {
  return (
    Object.values(state.offers).some(
      (offer) => offer.operatorId === operatorId && offer.callId !== exceptCallId,
    ) ||
    Object.values(state.calls).some(
      (call) =>
        call.callId !== exceptCallId &&
        ["ringing", "accepted", "ending"].includes(call.status) &&
        (call.outgoingBy?.operatorId === operatorId || call.winner?.operatorId === operatorId),
    )
  );
}

function terminal(call: CoordinatedCall): boolean {
  return ["ended", "declined", "canceled", "expired"].includes(call.status);
}

function recordTerminalReceipts(state: CoordinatorState): void {
  for (const call of Object.values(state.calls)) {
    if (!terminal(call) || call.endedAt == null || state.timelineReceipts[call.callId]) continue;
    const mediaEnd = call.mediaDisconnectedAt ?? call.endedAt;
    const connected = call.mediaConnectedAt != null;
    const outcome: CallTimelineReceipt["outcome"] =
      call.status === "declined"
        ? "declined"
        : call.status === "canceled"
          ? "canceled"
          : connected
            ? "ended"
            : "missed";
    state.timelineReceipts[call.callId] = {
      callId: call.callId,
      sessionId: call.sessionId,
      startedAt: call.createdAt,
      connectedAt: call.mediaConnectedAt ?? null,
      connectedTimeProvenance: call.mediaStartProvenance ?? null,
      endedAt: mediaEnd,
      connectedDurationMs: call.mediaConnectedAt != null ? mediaEnd - call.mediaConnectedAt : 0,
      outcome,
      endTimeProvenance: call.mediaEndProvenance ?? "server_transition",
      revision: call.revision,
    };
    emit(state, call, "receipt");
  }
}

function clone(state: CoordinatorState): CoordinatorState {
  return structuredClone(state);
}

/** One call to this pure reducer becomes one DO storage transaction later. */
export function applyCallCommand(
  previous: CoordinatorState,
  command: CallCommand,
): { state: CoordinatorState; result: CallReceipt } {
  const state = clone(previous);
  const fingerprint = JSON.stringify(command, (key, value) => (key === "now" ? undefined : value));
  const prior = state.receipts[command.eventId];
  const current = "callId" in command ? state.calls[command.callId] : undefined;
  if (prior)
    return {
      state: previous,
      result:
        prior.fingerprint === fingerprint
          ? {
              ...prior.result,
              status: current?.status ?? prior.result.status,
              revision: current?.revision ?? prior.result.revision,
            }
          : receipt(current, "unavailable", "callId" in command ? command.callId : ""),
    };

  const finish = (result: CallReceipt) => {
    state.receipts[command.eventId] = { fingerprint, result, createdAt: command.now };
    recordTerminalReceipts(state);
    return { state, result };
  };
  if ("operator" in command && command.operator && command.operator.tenantId !== state.tenantId)
    return finish(receipt(current, "unavailable", command.callId));

  if (command.type === "invite_visitor" || command.type === "invite_operator") {
    const existing = Object.values(state.calls).find(
      (call) => call.sessionId === command.sessionId && !terminal(call),
    );
    if (existing || state.calls[command.callId])
      return finish(
        receipt(existing ?? state.calls[command.callId], "unavailable", command.callId),
      );
    const pending = Object.values(state.calls).filter((call) =>
      ["waiting", "ringing"].includes(call.status),
    ).length;
    if (pending >= state.maxPending)
      return finish(receipt(undefined, "unavailable", command.callId));
    if (command.type === "invite_operator" && operatorBusy(state, command.operator.operatorId))
      return finish(receipt(undefined, "operator_busy", command.callId));
    const call: CoordinatedCall = {
      callId: command.callId,
      sessionId: command.sessionId,
      requestedBy: command.type === "invite_visitor" ? "visitor" : "operator",
      status: command.type === "invite_visitor" ? "waiting" : "ringing",
      createdAt: command.now,
      expiresAt: command.now + state.waitMs,
      revision: 1,
      ...(command.type === "invite_operator"
        ? {
            outgoingBy: {
              operatorId: command.operator.operatorId,
              deviceInstanceId: command.operator.deviceInstanceId,
            },
          }
        : {}),
    };
    state.calls[call.callId] = call;
    emit(state, call, "status");
    return finish(receipt(call, call.status === "waiting" ? "queued" : "offered", call.callId));
  }

  if (command.type === "revoke_device" || command.type === "revoke_operator") {
    for (const [deviceId, offer] of Object.entries(state.offers)) {
      if (
        (command.type === "revoke_device" && deviceId === command.deviceInstanceId) ||
        (command.type === "revoke_operator" && offer.operatorId === command.operatorId)
      ) {
        const call = state.calls[offer.callId];
        delete state.offers[deviceId];
        if (call) {
          excludeDevice(call, deviceId);
          if (command.type === "revoke_operator") excludeOperator(call, offer.operatorId);
          call.revision++;
          if (!Object.values(state.offers).some((remaining) => remaining.callId === call.callId))
            call.status = "waiting";
          emit(state, call, "stop_offer", deviceId);
          emit(state, call, "status");
        }
      }
    }
    for (const call of Object.values(state.calls)) {
      const claimant = call.winner ?? call.outgoingBy;
      if (
        !claimant ||
        !(
          (command.type === "revoke_device" &&
            claimant.deviceInstanceId === command.deviceInstanceId) ||
          (command.type === "revoke_operator" && claimant.operatorId === command.operatorId)
        )
      )
        continue;
      if (call.status === "accepted") {
        call.status = "ending";
        call.revision++;
        emit(state, call, "close_room");
        emit(state, call, "status");
      } else if (call.status === "ringing" && call.outgoingBy) {
        call.status = "canceled";
        call.endedAt = command.now;
        call.revision++;
        emit(state, call, "status");
      }
    }
    dispatchNextWaiting(state, command.now);
    return finish(receipt(undefined, "completed_self", ""));
  }

  const call = current;
  if (!call) return finish(receipt(undefined, "unavailable", command.callId));
  if (["waiting", "ringing"].includes(call.status) && command.now >= call.expiresAt) {
    call.status = "expired";
    call.endedAt = command.now;
    call.revision++;
    removeOffers(state, call);
    emit(state, call, "status");
    dispatchNextWaiting(state, command.now);
    return finish(receipt(call, "expired", call.callId));
  }

  if (command.type === "offer") {
    if (call.requestedBy !== "visitor" || !["waiting", "ringing"].includes(call.status))
      return finish(receipt(call, "unavailable", call.callId));
    if (
      call.ineligibleDevices?.includes(command.operator.deviceInstanceId) ||
      call.ineligibleOperators?.includes(command.operator.operatorId)
    )
      return finish(receipt(call, "unavailable", call.callId));
    const currentOffer = state.offers[command.operator.deviceInstanceId];
    if (
      (currentOffer &&
        (currentOffer.callId !== call.callId ||
          currentOffer.operatorId !== command.operator.operatorId)) ||
      operatorBusy(state, command.operator.operatorId, call.callId)
    )
      return finish(receipt(call, "operator_busy", call.callId));
    if (!currentOffer) {
      state.offers[command.operator.deviceInstanceId] = {
        callId: call.callId,
        operatorId: command.operator.operatorId,
        deviceInstanceId: command.operator.deviceInstanceId,
      };
      call.status = "ringing";
      call.revision++;
      emit(state, call, "offer", command.operator.deviceInstanceId);
      emit(state, call, "status");
    }
    return finish(receipt(call, "offered", call.callId));
  }

  if (command.type === "accept_operator") {
    if (call.status === "accepted")
      return finish(
        receipt(
          call,
          call.winner?.operatorId === command.operator.operatorId &&
            call.winner?.deviceInstanceId === command.operator.deviceInstanceId
            ? "accepted_self"
            : "answered_elsewhere",
          call.callId,
        ),
      );
    if (call.status === "canceled") return finish(receipt(call, "visitor_canceled", call.callId));
    if (call.status === "expired") return finish(receipt(call, "expired", call.callId));
    if (call.status !== "ringing" || call.requestedBy !== "visitor")
      return finish(receipt(call, "unavailable", call.callId));
    const offer = state.offers[command.operator.deviceInstanceId];
    if (!offer || offer.callId !== call.callId || offer.operatorId !== command.operator.operatorId)
      return finish(receipt(call, "unavailable", call.callId));
    if (operatorBusy(state, command.operator.operatorId, call.callId))
      return finish(receipt(call, "operator_busy", call.callId));
    call.status = "accepted";
    call.acceptedAt = command.now;
    call.joinDueAt = command.now + state.joinWaitMs;
    call.winner = { operatorId: offer.operatorId, deviceInstanceId: offer.deviceInstanceId };
    call.revision++;
    removeOffers(state, call, command.operator.deviceInstanceId);
    emit(state, call, "status");
    dispatchNextWaiting(state, command.now);
    return finish(receipt(call, "accepted_self", call.callId));
  }

  if (command.type === "decline_offer") {
    const offer = state.offers[command.operator.deviceInstanceId];
    if (call.status === "accepted") return finish(receipt(call, "answered_elsewhere", call.callId));
    if (call.status === "canceled") return finish(receipt(call, "visitor_canceled", call.callId));
    if (call.status === "expired") return finish(receipt(call, "expired", call.callId));
    if (!offer || offer.callId !== call.callId || offer.operatorId !== command.operator.operatorId)
      return finish(receipt(call, "unavailable", call.callId));
    delete state.offers[command.operator.deviceInstanceId];
    excludeDevice(call, command.operator.deviceInstanceId);
    if (
      !Object.values(state.offers).some(
        (remaining) =>
          remaining.callId === call.callId && remaining.operatorId === command.operator.operatorId,
      )
    )
      excludeOperator(call, command.operator.operatorId);
    call.revision++;
    if (!Object.values(state.offers).some((remaining) => remaining.callId === call.callId))
      call.status = "waiting";
    emit(state, call, "stop_offer", command.operator.deviceInstanceId);
    emit(state, call, "status");
    dispatchNextWaiting(state, command.now);
    return finish(receipt(call, "completed_self", call.callId));
  }

  if (command.type === "cancel_operator") {
    if (call.requestedBy !== "operator" || !call.outgoingBy)
      return finish(receipt(call, "unavailable", call.callId));
    if (
      call.outgoingBy.operatorId !== command.operator.operatorId ||
      call.outgoingBy.deviceInstanceId !== command.operator.deviceInstanceId
    )
      return finish(receipt(call, "answered_elsewhere", call.callId));
    if (terminal(call))
      return finish(
        receipt(call, call.status === "expired" ? "expired" : "completed_self", call.callId),
      );
    if (call.status !== "ringing") return finish(receipt(call, "unavailable", call.callId));
    call.status = "canceled";
    call.endedAt = command.now;
    call.revision++;
    emit(state, call, "status");
    dispatchNextWaiting(state, command.now);
    return finish(receipt(call, "completed_self", call.callId));
  }

  if (command.type === "accept_visitor") {
    if (call.requestedBy !== "operator" || call.status !== "ringing" || !call.outgoingBy)
      return finish(receipt(call, "unavailable", call.callId));
    call.status = "accepted";
    call.acceptedAt = command.now;
    call.joinDueAt = command.now + state.joinWaitMs;
    call.winner = call.outgoingBy;
    call.revision++;
    emit(state, call, "status");
    return finish(receipt(call, "accepted_self", call.callId));
  }

  if (command.type === "decline_visitor" || command.type === "cancel_visitor") {
    if (!["waiting", "ringing"].includes(call.status))
      return finish(receipt(call, "unavailable", call.callId));
    call.status = command.type === "decline_visitor" ? "declined" : "canceled";
    call.endedAt = command.now;
    call.revision++;
    removeOffers(state, call);
    emit(state, call, "status");
    dispatchNextWaiting(state, command.now);
    return finish(
      receipt(
        call,
        command.type === "decline_visitor" ? "completed_self" : "visitor_canceled",
        call.callId,
      ),
    );
  }

  if (command.type === "end") {
    if (call.status !== "accepted" && call.status !== "ending")
      return finish(receipt(call, "unavailable", call.callId));
    if (
      command.actor === "operator" &&
      (!command.operator ||
        call.winner?.operatorId !== command.operator.operatorId ||
        call.winner?.deviceInstanceId !== command.operator.deviceInstanceId)
    )
      return finish(receipt(call, "answered_elsewhere", call.callId));
    if (call.status === "ending") return finish(receipt(call, "completed_self", call.callId));
    call.status = "ending";
    call.revision++;
    emit(state, call, "close_room");
    emit(state, call, "status");
    return finish(receipt(call, "completed_self", call.callId));
  }

  if (command.type === "media_ended") {
    if (call.status !== "ending" && call.status !== "accepted")
      return finish(receipt(call, "unavailable", call.callId));
    call.status = "ended";
    call.endedAt = command.now;
    const exactSignedEnd =
      command.source === "signed_room_finished" &&
      command.occurredAt != null &&
      Number.isFinite(command.occurredAt) &&
      command.occurredAt >= (call.mediaConnectedAt ?? call.createdAt) &&
      command.occurredAt <= command.now;
    const verifiedAt = exactSignedEnd ? command.occurredAt! : command.now;
    call.mediaDisconnectedAt = verifiedAt;
    call.mediaEndProvenance = exactSignedEnd
      ? "signed_event"
      : command.source === "close_room_response"
        ? "confirmed_room_delete"
        : "observed_room_absent";
    call.revision++;
    emit(state, call, "status");
    dispatchNextWaiting(state, command.now);
    return finish(receipt(call, "completed_self", call.callId));
  }

  if (command.type === "media_joined") {
    const signedOnTime =
      command.source === "signed_livekit_event" &&
      command.occurredAt != null &&
      Number.isFinite(command.occurredAt) &&
      command.occurredAt >= (call.acceptedAt ?? call.createdAt) &&
      command.occurredAt <= command.now &&
      (!call.joinDueAt || command.occurredAt < call.joinDueAt);
    if (
      call.status !== "accepted" ||
      (call.joinDueAt && command.now >= call.joinDueAt && !call.mediaConnectedAt && !signedOnTime) ||
      call.winner?.operatorId !== command.operator.operatorId ||
      call.winner.deviceInstanceId !== command.operator.deviceInstanceId
    )
      return finish(receipt(call, "unavailable", call.callId));
    if (!call.mediaConnectedAt) {
      call.mediaConnectedAt = signedOnTime ? command.occurredAt : command.now;
      call.mediaStartProvenance = signedOnTime ? "signed_event" : "observed_room_present";
      call.revision++;
      emit(state, call, "status");
    }
    return finish(receipt(call, "completed_self", call.callId));
  }

  return finish(receipt(call, "unavailable", call.callId));
}

/** Alarm transition: expiry never refreshes the original visitor deadline. */
export function expireCoordinatedCalls(previous: CoordinatorState, now: number): CoordinatorState {
  const state = clone(previous);
  for (const call of Object.values(state.calls)) {
    if (["waiting", "ringing"].includes(call.status) && now >= call.expiresAt) {
      call.status = "expired";
      call.endedAt = now;
      call.revision++;
      removeOffers(state, call);
      emit(state, call, "status");
    } else if (
      call.status === "accepted" &&
      ((!call.mediaConnectedAt && !!call.joinDueAt && now >= call.joinDueAt) ||
        now >= (call.acceptedAt ?? call.createdAt) + CALL_MAX_DURATION_MS)
    ) {
      call.status = "ending";
      call.revision++;
      emit(state, call, "close_room");
      emit(state, call, "status");
    }
  }
  dispatchNextWaiting(state, now);
  recordTerminalReceipts(state);
  return state;
}

/** Old queued requests keep their original deadline; no ETA is manufactured. */
export function waitingCalls(state: CoordinatorState, now: number): CoordinatedCall[] {
  // filter creates a fresh array; Worker target typings do not include ES2023 toSorted.
  return (
    Object.values(state.calls)
      .filter((call) => call.status === "waiting" && call.expiresAt > now)
      // oxlint-disable-next-line unicorn/no-array-sort
      .sort((a, b) => a.createdAt - b.createdAt)
  );
}

/** Only the winning operator installation can obtain its media grant. */
export function operatorMayReceiveGrant(
  state: CoordinatorState,
  callId: string,
  operator: VerifiedCallOperator,
  now: number,
): boolean {
  const call = state.calls[callId];
  return (
    operator.tenantId === state.tenantId &&
    call?.status === "accepted" &&
    now < (call.acceptedAt ?? call.createdAt) + CALL_MAX_DURATION_MS &&
    (!!call.mediaConnectedAt || (!!call.joinDueAt && now < call.joinDueAt)) &&
    call.winner?.operatorId === operator.operatorId &&
    call.winner.deviceInstanceId === operator.deviceInstanceId
  );
}

export function acknowledgeCallOutbox(previous: CoordinatorState, key: string): CoordinatorState {
  if (!previous.outbox[key]) return previous;
  const state = clone(previous);
  delete state.outbox[key];
  return state;
}

/** Keep live calls and undelivered effects; expire only old settled receipts. */
export function pruneCoordinatorState(
  previous: CoordinatorState,
  now: number,
  retentionMs = DEFAULT_CALL_RECEIPT_RETENTION_MS,
): CoordinatorState {
  if (!Number.isFinite(retentionMs) || retentionMs <= 0)
    throw new Error("invalid call receipt retention");
  const state = clone(previous);
  const cutoff = now - retentionMs;
  for (const [callId, call] of Object.entries(state.calls)) {
    if (
      !terminal(call) ||
      call.endedAt == null ||
      call.endedAt > cutoff ||
      Object.values(state.outbox).some((event) => event.callId === callId)
    )
      continue;
    delete state.calls[callId];
    delete state.timelineReceipts[callId];
  }
  for (const [eventId, entry] of Object.entries(state.receipts)) {
    if (entry.createdAt > cutoff) continue;
    const call = state.calls[entry.result.callId];
    if (!call) delete state.receipts[eventId];
  }
  return state;
}
