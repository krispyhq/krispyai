import { callRtcAvailable, issueCoordinatedCallToken } from "./call-token";
import {
  operatorMayReceiveGrant,
  type CallCommand,
  type CallReceipt,
  type CoordinatedCall,
  type CoordinatorState,
  type VerifiedCallOperator,
} from "./call-coordinator-model";
import { publicCoordinatedCall } from "./call-authority";
import { DO_INTERNAL_HEADER, doInternalSecret, readTenantConfig } from "./store";
import { CALL_MAX_DURATION_MS } from "./call";
import type { Env, TenantConfig } from "./types";

type Actor = "visitor" | "operator";
type Authority = {
  owner: "legacy" | "coordinator" | null;
  current: boolean;
  callId: string | null;
  ownerVersion: number | null;
  status: string | null;
  call: ReturnType<typeof publicCoordinatedCall> | null;
  nonce?: string;
  tenantId: string | null;
  siteId: string;
  visitorRegistered: boolean;
  visitorPresent: boolean;
  visitorRequestReady: boolean;
  handoffState: string;
  cleanupPending: boolean;
};

const validId = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 200;
const validEvent = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
const trusted = (request: Request, env: Env) =>
  !!env.TENANT_SYNC_SECRET &&
  request.headers.get("x-tenant-sync-secret") === env.TENANT_SYNC_SECRET;

function sessionStub(env: Env, tenantId: string, sessionId: string) {
  return env.SESSION.get(env.SESSION.idFromName(`${tenantId}:${sessionId}`));
}

function coordinatorStub(env: Env, tenantId: string) {
  return env.CALL_COORDINATOR?.get(env.CALL_COORDINATOR.idFromName(tenantId));
}

function internalHeaders(env: Env, more: Record<string, string> = {}) {
  return { ...more, [DO_INTERNAL_HEADER]: doInternalSecret(env) };
}

async function authority(
  env: Env,
  tenantId: string,
  sessionId: string,
  actor: Actor,
  visitorSecret?: string,
  id?: string,
): Promise<Authority | null> {
  const stub = sessionStub(env, tenantId, sessionId);
  const response = await stub.fetch(
    `https://do/call/authority${id ? `?id=${encodeURIComponent(id)}` : ""}`,
    {
      headers: internalHeaders(env, {
        "x-call-actor": actor,
        ...(visitorSecret ? { "x-call-visitor-secret": visitorSecret } : {}),
      }),
    },
  );
  return response.ok ? ((await response.json()) as Authority) : null;
}

async function coordinatorState(env: Env, tenantId: string): Promise<CoordinatorState | null> {
  const stub = coordinatorStub(env, tenantId);
  if (!stub) return null;
  const response = await stub.fetch("https://do/state", { headers: internalHeaders(env) });
  return response.ok ? ((await response.json()) as { state: CoordinatorState }).state : null;
}

async function command(
  env: Env,
  tenantId: string,
  value: CallCommand,
): Promise<CallReceipt | null> {
  const stub = coordinatorStub(env, tenantId);
  if (!stub) return null;
  const response = await stub.fetch("https://do/command", {
    method: "POST",
    headers: internalHeaders(env, { "content-type": "application/json" }),
    body: JSON.stringify({ tenantId, command: value }),
  });
  return response.ok ? ((await response.json()) as CallReceipt) : null;
}

function runtimeReady(env: Env, tenantId: string) {
  return (
    env.NATIVE_CALLS_ENABLED === "1" &&
    env.CALL_PILOT_TENANT_ID === tenantId &&
    !!env.CALL_COORDINATOR &&
    !!env.API_ORIGIN &&
    !!env.PUSH_TRIGGER_SECRET &&
    callRtcAvailable({
      url: env.LIVEKIT_URL,
      apiKey: env.LIVEKIT_API_KEY,
      apiSecret: env.LIVEKIT_API_SECRET,
    })
  );
}

function callDecision(call: CoordinatedCall, disposition: CallReceipt["disposition"]) {
  return {
    callId: call.callId,
    sessionId: call.sessionId,
    status: call.status,
    revision: call.revision,
    expiresAt: call.expiresAt,
    disposition,
  };
}

function operatorDisposition(
  state: CoordinatorState,
  call: CoordinatedCall,
  who: VerifiedCallOperator,
): CallReceipt["disposition"] {
  if (call.status === "expired") return "expired";
  if (call.status === "canceled") return "visitor_canceled";
  if (call.status === "declined") return "completed_self";
  if (call.winner)
    return call.winner.operatorId === who.operatorId &&
      call.winner.deviceInstanceId === who.deviceInstanceId
      ? ["ending", "ended"].includes(call.status)
        ? "completed_self"
        : "accepted_self"
      : "answered_elsewhere";
  if (call.outgoingBy)
    return call.outgoingBy.operatorId === who.operatorId &&
      call.outgoingBy.deviceInstanceId === who.deviceInstanceId
      ? "offered"
      : "operator_busy";
  if (state.offers[who.deviceInstanceId]?.callId === call.callId) return "offered";
  return call.status === "waiting" ? "queued" : "unavailable";
}

async function claim(
  env: Env,
  tenantId: string,
  sessionId: string,
  actor: Actor,
  callId: string,
  eventId: string,
  visitorSecret?: string,
): Promise<{
  marker: { callId: string; version: number; nonce: string; eventId: string };
  reused: boolean;
} | null> {
  const response = await sessionStub(env, tenantId, sessionId).fetch("https://do/call/claim", {
    method: "POST",
    headers: internalHeaders(env, {
      "content-type": "application/json",
      "x-call-actor": actor,
      ...(visitorSecret ? { "x-call-visitor-secret": visitorSecret } : {}),
    }),
    body: JSON.stringify({ tenantId, sessionId, callId, eventId, requestedBy: actor }),
  });
  return response.ok
    ? ((await response.json()) as {
        marker: { callId: string; version: number; nonce: string; eventId: string };
        reused: boolean;
      })
    : null;
}

async function releaseClaim(
  env: Env,
  tenantId: string,
  sessionId: string,
  callId: string,
  version: number,
) {
  await sessionStub(env, tenantId, sessionId).fetch("https://do/call/release", {
    method: "POST",
    headers: internalHeaders(env, { "content-type": "application/json" }),
    body: JSON.stringify({ callId, version }),
  });
}

/** The Cloud API supplies the verified operator/installation; this route never trusts a bearer in JSON. */
export async function handleInternalCoordinatorCall(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  if (!trusted(request, env))
    return Response.json({ error: "system_auth_required" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !validId(body.tenantId) || !env.CALL_COORDINATOR)
    return Response.json({ error: "invalid_request" }, { status: 400 });
  const tenantId = body.tenantId as string;
  if (path === "offer-validity") {
    const response = await coordinatorStub(env, tenantId)!.fetch("https://do/offer-validity", {
      method: "POST",
      headers: internalHeaders(env, { "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    return response;
  }
  if (path === "revoke-device") {
    if (!validId(body.deviceInstanceId) || !validEvent(body.actionEventId))
      return Response.json({ error: "invalid_request" }, { status: 400 });
    await command(env, tenantId, {
      type: "revoke_device",
      deviceInstanceId: body.deviceInstanceId as string,
      eventId: body.actionEventId as string,
      now: Date.now(),
    });
    const state = await coordinatorState(env, tenantId);
    const device = body.deviceInstanceId as string;
    const pending =
      !!state &&
      (!!state.offers[device] ||
        Object.values(state.calls).some(
          (call) =>
            ["ringing", "accepted", "ending"].includes(call.status) &&
            (call.winner?.deviceInstanceId === device ||
              call.outgoingBy?.deviceInstanceId === device),
        ) ||
        Object.values(state.outbox).some(
          (event) =>
            event.deviceInstanceId === device && ["offer", "stop_offer"].includes(event.kind),
        ));
    return Response.json({ cleanupConfirmed: !pending }, { status: pending ? 202 : 200 });
  }
  if (!validId(body.sessionId) || !validId(body.operatorId) || !validId(body.deviceInstanceId))
    return Response.json({ error: "invalid_request" }, { status: 400 });
  const sessionId = body.sessionId as string;
  const operator: VerifiedCallOperator = {
    tenantId,
    operatorId: body.operatorId as string,
    deviceInstanceId: body.deviceInstanceId as string,
  };
  const owner = await authority(
    env,
    tenantId,
    sessionId,
    "operator",
    undefined,
    typeof body.callId === "string" ? body.callId : undefined,
  );
  if (!owner || (owner.tenantId && owner.tenantId !== tenantId))
    return Response.json({ error: "call_not_found" }, { status: 404 });
  const config = await readTenantConfig(env, tenantId, owner.siteId);
  if (path === "availability") {
    if (!runtimeReady(env, tenantId) || !config?.callSettings?.enabled)
      return Response.json({ canInvite: false, reason: "disabled" });
    if (owner.cleanupPending) return Response.json({ canInvite: false, reason: "cleanup_pending" });
    if (!owner.visitorRegistered || !owner.visitorPresent)
      return Response.json({ canInvite: false, reason: "visitor_offline" });
    const state = await coordinatorState(env, tenantId);
    const busy =
      (owner.owner === "coordinator" &&
        ["waiting", "ringing", "accepted", "ending"].includes(owner.status || "")) ||
      (owner.owner === "legacy" && ["ringing", "accepted"].includes(owner.status || "")) ||
      (!!state &&
        (Object.values(state.offers).some((offer) => offer.operatorId === operator.operatorId) ||
          Object.values(state.calls).some(
            (call) =>
              ["ringing", "accepted", "ending"].includes(call.status) &&
              (call.winner?.operatorId === operator.operatorId ||
                call.outgoingBy?.operatorId === operator.operatorId),
          )));
    return Response.json({ canInvite: !busy, reason: busy ? "operator_busy" : "enabled" });
  }
  if (path === "start") {
    if (!runtimeReady(env, tenantId) || !config?.callSettings?.enabled)
      return Response.json({ error: "tenant_calls_disabled" }, { status: 403 });
    if (!owner.visitorRegistered || !owner.visitorPresent)
      return Response.json({ error: "visitor_unavailable" }, { status: 409 });
    if (!validEvent(body.actionEventId))
      return Response.json({ error: "invalid_request" }, { status: 400 });
    const initialId = crypto.randomUUID();
    const marker = await claim(
      env,
      tenantId,
      sessionId,
      "operator",
      initialId,
      body.actionEventId as string,
    );
    if (!marker) return Response.json({ error: "call_unavailable" }, { status: 409 });
    const result = await command(env, tenantId, {
      type: "invite_operator",
      callId: marker.marker.callId,
      sessionId,
      eventId: body.actionEventId as string,
      now: Date.now(),
      operator,
    });
    const state = await coordinatorState(env, tenantId);
    const call = state?.calls[marker.marker.callId];
    if (
      !result ||
      !call ||
      result.disposition === "unavailable" ||
      result.disposition === "operator_busy"
    ) {
      await releaseClaim(env, tenantId, sessionId, marker.marker.callId, marker.marker.version);
      return Response.json(
        { error: result?.disposition === "operator_busy" ? "operator_busy" : "call_unavailable" },
        { status: 409 },
      );
    }
    return Response.json(callDecision(call, result.disposition));
  }
  if (
    !validId(body.callId) ||
    (path !== "status" && !owner.current) ||
    owner.owner !== "coordinator" ||
    owner.callId !== body.callId
  )
    return Response.json({ error: "call_not_found" }, { status: 404 });
  const callId = body.callId as string;
  const state = await coordinatorState(env, tenantId);
  const call = state?.calls[callId];
  if (!call || call.sessionId !== sessionId)
    return Response.json({ error: "call_not_found" }, { status: 404 });
  if (path === "status")
    return Response.json(callDecision(call, operatorDisposition(state!, call, operator)));
  if (path === "grant") {
    if (!operatorMayReceiveGrant(state!, callId, operator, Date.now()))
      return Response.json({ error: "call_not_accepted" }, { status: 409 });
    const grant = await issueCoordinatedCallToken(
      { url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET },
      callId,
      "operator",
    );
    const after = await coordinatorState(env, tenantId);
    const afterOwner = await authority(env, tenantId, sessionId, "operator", undefined, callId);
    if (
      !grant ||
      !after ||
      !afterOwner?.current ||
      afterOwner.ownerVersion !== owner.ownerVersion ||
      !operatorMayReceiveGrant(after, callId, operator, Date.now())
    )
      return Response.json({ error: "call_not_accepted" }, { status: 409 });
    return Response.json({
      callId,
      revision: after.calls[callId]!.revision,
      livekitUrl: grant.url,
      token: grant.token,
    });
  }
  if (path === "action") {
    if (!validEvent(body.actionEventId))
      return Response.json({ error: "invalid_request" }, { status: 400 });
    const action = body.action;
    if (action === "accept" && !runtimeReady(env, tenantId))
      return Response.json({ error: "call_unavailable" }, { status: 503 });
    const type =
      action === "accept"
        ? "accept_operator"
        : action === "decline"
          ? "decline_offer"
          : action === "cancel_outgoing"
            ? "cancel_operator"
            : action === "end"
              ? "end"
              : null;
    if (!type) return Response.json({ error: "invalid_action" }, { status: 400 });
    const base = { callId, eventId: body.actionEventId as string, now: Date.now(), operator };
    const commandValue: CallCommand =
      type === "end" ? { ...base, type: "end", actor: "operator" } : { ...base, type };
    const result = await command(env, tenantId, commandValue);
    const next = await coordinatorState(env, tenantId);
    const updated = next?.calls[callId];
    return result && updated
      ? Response.json(callDecision(updated, result.disposition))
      : Response.json({ error: "call_unavailable" }, { status: 503 });
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

/** Session capability and nonce are checked before every 0.5 guest mutation. */
export async function handleGuestCoordinatedCall(
  env: Env,
  tenantId: string,
  sessionId: string,
  body: Record<string, unknown>,
  clientUrl: string | undefined,
  config: TenantConfig | null,
): Promise<Response | null> {
  const secret = body.visitorSecret as string;
  const owner = await authority(
    env,
    tenantId,
    sessionId,
    "visitor",
    secret,
    typeof body.id === "string" ? body.id : undefined,
  );
  if (!owner) return Response.json({ error: "visitor_auth_required" }, { status: 403 });
  const alreadyOwned = owner.owner === "coordinator" && owner.current;
  if (!alreadyOwned && (body.action !== "invite" || !runtimeReady(env, tenantId))) return null;
  if (body.action === "invite") {
    if (
      !runtimeReady(env, tenantId) ||
      !config?.callSettings?.enabled ||
      !config.callSettings.visitorRequestsEnabled
    )
      return Response.json({ error: "call_disabled" }, { status: 403 });
    if (owner.owner === "legacy" && ["ringing", "accepted"].includes(owner.status || ""))
      return Response.json({ error: "call_in_progress" }, { status: 409 });
    if (config.callSettings.visitorRequestTrigger !== "always" && owner.handoffState === "ai")
      return Response.json({ error: "handoff_required" }, { status: 409 });
    if (!owner.visitorRequestReady)
      return Response.json({ error: "call_request_rate_limited" }, { status: 429 });
    const marker = await claim(
      env,
      tenantId,
      sessionId,
      "visitor",
      crypto.randomUUID(),
      crypto.randomUUID(),
      secret,
    );
    if (!marker) return Response.json({ error: "call_unavailable" }, { status: 409 });
    const result = await command(env, tenantId, {
      type: "invite_visitor",
      callId: marker.marker.callId,
      sessionId,
      eventId: marker.marker.eventId,
      now: Date.now(),
    });
    const state = await coordinatorState(env, tenantId);
    const call = state?.calls[marker.marker.callId];
    if (!result || !call || result.disposition === "unavailable") {
      await releaseClaim(env, tenantId, sessionId, marker.marker.callId, marker.marker.version);
      return Response.json({ error: "call_unavailable" }, { status: 409 });
    }
    return Response.json({ call: publicCoordinatedCall(call), nonce: marker.marker.nonce });
  }
  if (owner.callId !== body.id && body.action !== "status")
    return Response.json({ error: "stale_call" }, { status: 409 });
  const state = await coordinatorState(env, tenantId);
  const call = owner.callId && state?.calls[owner.callId];
  if (body.action === "status")
    return Response.json({
      call: call ? publicCoordinatedCall(call) : owner.call,
      nonce: owner.nonce,
      available: true,
      visitorRequestReady: owner.visitorRequestReady,
      handoffState: owner.handoffState,
    });
  if (!call) return Response.json({ error: "call_not_found" }, { status: 404 });
  if (body.action === "grant") {
    if (
      call.status !== "accepted" ||
      !call.winner ||
      Date.now() >= (call.acceptedAt ?? call.createdAt) + CALL_MAX_DURATION_MS ||
      (!call.mediaConnectedAt && call.joinDueAt != null && Date.now() >= call.joinDueAt)
    )
      return Response.json({ error: "call_not_accepted" }, { status: 409 });
    const grant = await issueCoordinatedCallToken(
      { url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET },
      call.callId,
      "visitor",
    );
    const after = await coordinatorState(env, tenantId);
    const afterOwner = await authority(env, tenantId, sessionId, "visitor", secret, call.callId);
    if (
      !grant ||
      !afterOwner?.current ||
      afterOwner.ownerVersion !== owner.ownerVersion ||
      after?.calls[call.callId]?.status !== "accepted"
    )
      return Response.json({ error: "call_not_accepted" }, { status: 409 });
    return Response.json({
      url: grant.url,
      token: grant.token,
      expiresAt: grant.expiresAt,
      clientUrl,
    });
  }
  if (body.nonce !== owner.nonce) return Response.json({ error: "invalid_nonce" }, { status: 403 });
  const type =
    body.action === "accept"
      ? "accept_visitor"
      : body.action === "decline"
        ? "decline_visitor"
        : body.action === "cancel"
          ? "cancel_visitor"
          : body.action === "end"
            ? "end"
            : null;
  if (!type) return Response.json({ error: "invalid_action" }, { status: 400 });
  if ((type === "accept_visitor" || type === "decline_visitor") && call.requestedBy === "visitor")
    return Response.json({ error: "wrong_actor" }, { status: 403 });
  if (type === "cancel_visitor" && call.requestedBy !== "visitor")
    return Response.json({ error: "wrong_actor" }, { status: 403 });
  if (type === "accept_visitor" && !runtimeReady(env, tenantId))
    return Response.json({ error: "call_unavailable" }, { status: 503 });
  const base = { callId: call.callId, eventId: crypto.randomUUID(), now: Date.now() };
  const result =
    type === "end"
      ? await command(env, tenantId, { ...base, type, actor: "visitor" })
      : await command(env, tenantId, { ...base, type });
  const next = await coordinatorState(env, tenantId);
  const changed = next?.calls[call.callId];
  return result && changed
    ? Response.json({ call: publicCoordinatedCall(changed) })
    : Response.json({ error: "call_unavailable" }, { status: 503 });
}

export function nativeCallPilotEnabled(env: Env, tenantId: string): boolean {
  return runtimeReady(env, tenantId);
}
