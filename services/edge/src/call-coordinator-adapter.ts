// Staged coordinator boundary. No route or DO binding invokes this yet; runtime
// 0.4 continues to use SessionDO. A future tenant DO supplies transactional storage
// and the cloud API supplies authenticated operator/device context.
import {
  applyCallCommand,
  type CallCommand,
  type CallReceipt,
  type CoordinatorState,
  type VerifiedCallOperator,
} from "./call-coordinator-model";
import { publicWidgetConfig } from "./store";
import type { TenantConfig } from "./types";

export interface CoordinatorTransaction {
  get(key: string): Promise<CoordinatorState | undefined>;
  put(key: string, value: CoordinatorState): Promise<void>;
}

export interface CoordinatorStorage {
  /** The tenant DO serializes this read/reduce/write as one storage transaction. */
  transaction<T>(run: (tx: CoordinatorTransaction) => Promise<T>): Promise<T>;
}

/** Wrap a tenant DO's actual transactional storage without registering a binding. */
export function tenantCoordinatorStorage(state: DurableObjectState): CoordinatorStorage {
  return {
    transaction: (run) =>
      state.storage.transaction((tx) =>
        run({
          get: (key) => tx.get<CoordinatorState>(key),
          put: (key, value) => tx.put(key, value),
        }),
      ),
  };
}

export interface VerifiedCallAccess {
  operator: VerifiedCallOperator;
  /** Bound to the actual Better Auth session and registered installation. */
  expiresAt: number;
}

export interface CoordinatorBoundary {
  /** Verify bearer or call-only access with Cloud; never trust IDs in request JSON. */
  verifyOperator(request: Request): Promise<VerifiedCallAccess | null>;
  /** Only a trusted room webhook or internal reconciler may close occupancy. */
  verifySystemEvent(request: Request, tenantId: string): Promise<boolean>;
  /** Query LiveKit or verify its signed room-finished event. */
  verifyRoomClosed(callId: string, evidence: unknown): Promise<boolean>;
}

export type CoordinatorAction = "accept" | "decline" | "cancel_outgoing" | "end";
export type CoordinatorOutcome =
  | { ok: true; receipt: CallReceipt }
  | { ok: false; status: 400 | 401 | 403 | 404 | 409 | 503; error: string };

const STATE_KEY = "coordinator:v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[A-Za-z0-9:_-]{1,128}$/;

function parseAction(
  raw: unknown,
): { callId: string; sessionId: string; eventId: string; action: CoordinatorAction } | null {
  if (!raw || typeof raw !== "object") return null;
  const body = new Map<string, unknown>(Object.entries(raw));
  const callId = body.get("callId");
  const sessionId = body.get("sessionId");
  const eventId = body.get("eventId");
  const action = body.get("action");
  if (
    typeof callId !== "string" ||
    !UUID.test(callId) ||
    typeof sessionId !== "string" ||
    !sessionId ||
    sessionId.length > 200 ||
    typeof eventId !== "string" ||
    !EVENT_ID.test(eventId) ||
    (action !== "accept" &&
      action !== "decline" &&
      action !== "cancel_outgoing" &&
      action !== "end")
  )
    return null;
  return { callId, sessionId, eventId, action };
}

/** Only configured public forms/CTAs can be offered after busy or timeout. */
export function configuredCallFallback(config: TenantConfig | null) {
  const publicConfig = publicWidgetConfig(config);
  return {
    forms: publicConfig.forms,
    ctas: publicConfig.ctas,
    fallbackAvailable: publicConfig.forms.length > 0 || publicConfig.ctas.length > 0,
  };
}

/**
 * Validates a native action, resolves identity outside the body, then mutates one
 * tenant's durable state. The route must also gate this path to runtime 0.5 and
 * check current membership/device availability before calling verifyOperator.
 */
export async function applyOperatorCoordinatorAction(
  storage: CoordinatorStorage,
  boundary: CoordinatorBoundary,
  request: Request,
  raw: unknown,
  tenantId: string,
  now: number,
): Promise<CoordinatorOutcome> {
  const body = parseAction(raw);
  if (!body) return { ok: false, status: 400, error: "invalid_call_action" };
  const access = await boundary.verifyOperator(request);
  if (!access || access.expiresAt <= now)
    return { ok: false, status: 401, error: "call_auth_expired" };
  if (access.operator.tenantId !== tenantId)
    return { ok: false, status: 403, error: "call_tenant_mismatch" };
  return storage.transaction(async (tx) => {
    const state = await tx.get(STATE_KEY);
    const call = state?.calls[body.callId];
    if (!state || state.tenantId !== tenantId || !call || call.sessionId !== body.sessionId)
      return { ok: false, status: 404, error: "call_not_found" } as const;
    const base = { callId: body.callId, eventId: body.eventId, now, operator: access.operator };
    let command: CallCommand;
    switch (body.action) {
      case "accept":
        command = { ...base, type: "accept_operator" };
        break;
      case "decline":
        command = { ...base, type: "decline_offer" };
        break;
      case "cancel_outgoing":
        command = { ...base, type: "cancel_operator" };
        break;
      case "end":
        command = { ...base, type: "end", actor: "operator" };
        break;
    }
    const result = applyCallCommand(state, command);
    await tx.put(STATE_KEY, result.state);
    return { ok: true, receipt: result.result } as const;
  });
}

/** A caller-provided source string is never accepted as proof of room closure. */
export async function applyVerifiedRoomClosure(
  storage: CoordinatorStorage,
  boundary: CoordinatorBoundary,
  request: Request,
  tenantId: string,
  callId: string,
  eventId: string,
  evidence: unknown,
  now: number,
): Promise<CoordinatorOutcome> {
  if (!UUID.test(callId) || !EVENT_ID.test(eventId))
    return { ok: false, status: 400, error: "invalid_call_event" };
  if (!(await boundary.verifySystemEvent(request, tenantId)))
    return { ok: false, status: 401, error: "system_auth_required" };
  const belongsToTenant = await storage.transaction(async (tx) => {
    const state = await tx.get(STATE_KEY);
    return state?.tenantId === tenantId && !!state.calls[callId];
  });
  if (!belongsToTenant) return { ok: false, status: 404, error: "call_not_found" };
  if (!(await boundary.verifyRoomClosed(callId, evidence)))
    return { ok: false, status: 409, error: "room_not_closed" };
  return storage.transaction(async (tx) => {
    const state = await tx.get(STATE_KEY);
    if (!state || state.tenantId !== tenantId || !state.calls[callId])
      return { ok: false, status: 404, error: "call_not_found" } as const;
    const result = applyCallCommand(state, {
      type: "media_ended",
      callId,
      eventId,
      now,
      source: "verified_room_absent",
    });
    await tx.put(STATE_KEY, result.state);
    return { ok: true, receipt: result.result } as const;
  });
}
