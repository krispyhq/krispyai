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
  /** Set only after the server verifies LiveKit participant presence. */
  mediaConnectedAt?: number;
  endedAt?: number;
  /** Outgoing calls reserve their operator before the visitor answers. */
  outgoingBy?: Pick<VerifiedCallOperator, "operatorId" | "deviceInstanceId">;
  /** Keep this claim through `ending` until room termination is confirmed. */
  winner?: Pick<VerifiedCallOperator, "operatorId" | "deviceInstanceId">;
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

export interface CallOutboxEvent {
  key: string;
  kind: "status" | "offer" | "stop_offer" | "close_room" | "dispatch";
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
  receipts: Record<string, { fingerprint: string; result: CallReceipt }>;
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
    }
  | {
      type: "media_joined";
      callId: string;
      eventId: string;
      now: number;
      operator: VerifiedCallOperator;
      /** An authenticated client intent alone is insufficient. */
      source: "signed_livekit_event" | "verified_room_query";
    }
  | { type: "revoke_device"; deviceInstanceId: string; eventId: string; now: number }
  | { type: "revoke_operator"; operatorId: string; eventId: string; now: number };

export const defaultCallWaitMs = CALL_INVITE_TTL_MS;
export const DEFAULT_CALL_JOIN_WAIT_MS = 30_000;

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
    state.receipts[command.eventId] = { fingerprint, result };
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
    call.revision++;
    if (!Object.values(state.offers).some((remaining) => remaining.callId === call.callId))
      call.status = "waiting";
    emit(state, call, "stop_offer", command.operator.deviceInstanceId);
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
    call.revision++;
    emit(state, call, "status");
    dispatchNextWaiting(state, command.now);
    return finish(receipt(call, "completed_self", call.callId));
  }

  if (command.type === "media_joined") {
    if (
      call.status !== "accepted" ||
      (call.joinDueAt && command.now >= call.joinDueAt && !call.mediaConnectedAt) ||
      call.winner?.operatorId !== command.operator.operatorId ||
      call.winner.deviceInstanceId !== command.operator.deviceInstanceId
    )
      return finish(receipt(call, "unavailable", call.callId));
    if (!call.mediaConnectedAt) {
      call.mediaConnectedAt = command.now;
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
