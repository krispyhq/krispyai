/** One invitation per chat session. Persist this value in its SessionDO only. */
export const CALL_INVITE_TTL_MS = 60_000;
export const CALL_MAX_DURATION_MS = 60 * 60_000;

export type CallStatus = "ringing" | "accepted" | "declined" | "canceled" | "expired" | "ended";
export interface CallState {
  id: string;
  /** Opaque, random room name; contains no tenant, session, or person identifier. */
  room: string;
  status: CallStatus;
  createdAt: number;
  expiresAt: number;
  acceptedAt?: number;
  endedAt?: number;
}

export type CallAction = "accept" | "decline" | "cancel" | "end";
export type CallResult =
  | { ok: true; call: CallState; changed: boolean }
  | { ok: false; reason: "no_invitation" | "not_ringing" | "not_accepted" | "expired" };

/** Make expiry explicit when reading durable state or processing an action. */
export function currentCall(call: CallState | null | undefined, now: number): CallState | null {
  if (!call) return null;
  if (call.status === "ringing" && now >= call.expiresAt) {
    return { ...call, status: "expired", endedAt: now };
  }
  if (
    call.status === "accepted" &&
    now >= (call.acceptedAt ?? call.createdAt) + CALL_MAX_DURATION_MS
  ) {
    return { ...call, status: "ended", endedAt: now };
  }
  return call;
}

/** Idempotent only while an invitation is ringing. A terminal call gets a fresh room. */
export function inviteCall(
  previous: CallState | null | undefined,
  now: number,
  id: string = crypto.randomUUID(),
): CallResult {
  const call = currentCall(previous, now);
  if (call?.status === "ringing") return { ok: true, call, changed: false };
  if (call?.status === "accepted") return { ok: false, reason: "not_ringing" };
  return {
    ok: true,
    call: {
      id,
      room: `krispy-${id}`,
      status: "ringing",
      createdAt: now,
      expiresAt: now + CALL_INVITE_TTL_MS,
    },
    changed: true,
  };
}

/** Authorization belongs to the Worker route: visitor accepts/declines, operator cancels. */
export function transitionCall(
  previous: CallState | null | undefined,
  action: CallAction,
  now: number,
  expectedId: string,
): CallResult {
  const call = currentCall(previous, now);
  if (!call || call.id !== expectedId) return { ok: false, reason: "no_invitation" };
  if (action === "end") {
    if (call.status === "ended") return { ok: true, call, changed: false };
    if (call.status !== "accepted") return { ok: false, reason: "not_accepted" };
    return { ok: true, call: { ...call, status: "ended", endedAt: now }, changed: true };
  }
  const target = action === "accept" ? "accepted" : action === "decline" ? "declined" : "canceled";
  if (call.status === target) return { ok: true, call, changed: false };
  if (call.status === "expired") return { ok: false, reason: "expired" };
  if (call.status !== "ringing") return { ok: false, reason: "not_ringing" };
  return {
    ok: true,
    call: {
      ...call,
      status: target,
      ...(target === "accepted" ? { acceptedAt: now } : { endedAt: now }),
    },
    changed: true,
  };
}

/** The sole permission gate for issuing either participant's room token. */
export function canJoinCall(
  call: CallState | null | undefined,
  expectedId: string,
  now: number,
): boolean {
  const current = currentCall(call, now);
  return current?.id === expectedId && current.status === "accepted";
}

export function publicCall(call: CallState | null | undefined, now: number) {
  const current = currentCall(call, now);
  if (!current) return null;
  const { id, status, createdAt, expiresAt, acceptedAt, endedAt } = current;
  return { id, status, createdAt, expiresAt, acceptedAt, endedAt };
}
