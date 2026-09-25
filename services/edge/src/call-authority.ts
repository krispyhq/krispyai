import type { CoordinatedCall, CoordinatedCallStatus } from "./call-coordinator-model";
import type { CallState } from "./call";

/** SessionDO pins a call's owner before either call engine may mutate it. */
export interface CallAuthority {
  owner: "coordinator";
  callId: string;
  version: number;
  eventId: string;
  requestedBy: "visitor" | "operator";
  status: CoordinatedCallStatus;
  revision: number;
  nonce: string;
  /** Bounds a claim if the Worker dies before the tenant coordinator records it. */
  claimExpiresAt: number;
  publicCall?: {
    id: string;
    status: "ringing" | "accepted" | "declined" | "canceled" | "expired" | "ended";
    requestedBy: "visitor" | "operator";
    createdAt: number;
    expiresAt: number;
    acceptedAt: number | undefined;
    endedAt: number | undefined;
  };
}

export function coordinatorOwnsActiveCall(authority: CallAuthority | null | undefined): boolean {
  return !!authority && ["waiting", "ringing", "accepted", "ending"].includes(authority.status);
}

/** Legacy SessionDO state stays authoritative until it reaches a terminal state and its room closes. */
export function legacyOwnsActiveCall(
  call: CallState | null | undefined,
  cleanupRoom: string | null | undefined,
): boolean {
  return !!cleanupRoom || (!!call && (call.status === "ringing" || call.status === "accepted"));
}

export function coordinatorPublicStatus(
  status: CoordinatedCallStatus,
): NonNullable<CallAuthority["publicCall"]>["status"] {
  if (status === "waiting") return "ringing";
  if (status === "ending") return "ended";
  return status;
}

export function publicCoordinatedCall(
  call: CoordinatedCall,
): NonNullable<CallAuthority["publicCall"]> {
  return {
    id: call.callId,
    status: coordinatorPublicStatus(call.status),
    requestedBy: call.requestedBy,
    createdAt: call.createdAt,
    expiresAt: call.expiresAt,
    acceptedAt: call.acceptedAt,
    endedAt: call.endedAt,
  };
}
