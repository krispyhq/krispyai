import { verifyLivekitWebhook } from "./call-token";
import { DO_INTERNAL_HEADER, doInternalSecret } from "./store";
import type { Env } from "./types";

const ROOM = /^krispy-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Pilot tenant coordinator locates the call; SessionDO confirms persisted ownership. */
export async function handleLivekitWebhook(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  const event = await verifyLivekitWebhook(
    { apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET },
    raw,
    request.headers.get("authorization"),
  );
  if (!event) return Response.json({ error: "invalid_webhook" }, { status: 401 });
  const eventType = event.event;
  if (!["participant_joined", "participant_left", "room_finished"].includes(String(eventType)))
    return Response.json({ ignored: true });
  const callId = ROOM.exec((event.room as { name?: unknown } | undefined)?.name as string)?.[1];
  if (!callId || !EVENT_ID.test(String(event.id))) return Response.json({ ignored: true });
  const tenantId = env.CALL_PILOT_TENANT_ID;
  if (!tenantId || !env.CALL_COORDINATOR) return Response.json({ ignored: true });
  const coordinator = env.CALL_COORDINATOR.get(env.CALL_COORDINATOR.idFromName(tenantId));
  const located = await coordinator.fetch(`https://do/call-route?id=${callId}`, {
    headers: { [DO_INTERNAL_HEADER]: doInternalSecret(env) },
  });
  if (located.status === 404) return Response.json({ ignored: true }); // Legacy 0.4 owner.
  if (!located.ok) return Response.json({ error: "owner_unavailable" }, { status: 503 });
  const route = (await located.json()) as { tenantId: string; sessionId: string };
  if (route.tenantId !== tenantId || !route.sessionId)
    return Response.json({ error: "owner_unavailable" }, { status: 503 });
  const session = env.SESSION.get(env.SESSION.idFromName(`${route.tenantId}:${route.sessionId}`));
  const authority = await session.fetch(`https://do/call/authority?id=${callId}`, {
    headers: { [DO_INTERNAL_HEADER]: doInternalSecret(env), "x-call-actor": "operator" },
  });
  if (!authority.ok) return Response.json({ error: "owner_unavailable" }, { status: 503 });
  const owner = (await authority.json()) as { owner?: string; callId?: string; tenantId?: string };
  if (owner.owner !== "coordinator" || owner.callId !== callId || owner.tenantId !== route.tenantId)
    return Response.json({ ignored: true });
  const occurredAt =
    typeof event.createdAt === "number" && Number.isInteger(event.createdAt)
      ? event.createdAt * 1000
      : null;
  const response = await coordinator.fetch("https://do/signed-webhook", {
    method: "POST",
    headers: { [DO_INTERNAL_HEADER]: doInternalSecret(env), "content-type": "application/json" },
    body: JSON.stringify({
      tenantId: route.tenantId,
      sessionId: route.sessionId,
      callId,
      eventId: event.id,
      eventType,
      occurredAt,
      participantIdentity: (event.participant as { identity?: unknown } | undefined)?.identity,
    }),
  });
  if (!response.ok) return Response.json({ error: "webhook_retry" }, { status: 503 });
  return Response.json({ acknowledged: true });
}
