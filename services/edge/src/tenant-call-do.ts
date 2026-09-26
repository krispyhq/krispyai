import { closeCallRoom, observeCallRoom } from "./call-token";
import { COORDINATOR_STATE_KEY } from "./call-coordinator-adapter";
import {
  acknowledgeCallOutbox,
  applyCallCommand,
  callSignalDeviceInstanceIds,
  createCoordinatorState,
  expireCoordinatedCalls,
  offerStillValid,
  pruneCoordinatorState,
  type CallCommand,
  type CallOutboxEvent,
  type CoordinatorState,
  type VerifiedCallOperator,
} from "./call-coordinator-model";
import { CALL_MAX_DURATION_MS } from "./call";
import { DO_INTERNAL_HEADER, doInternalSecret } from "./store";
import type { Env } from "./types";

type CommandBody = { tenantId: string; command: CallCommand };
type CloudDevice = { operatorId: string; deviceInstanceId: string; platform: "ios" };
type SignedWebhook = {
  tenantId: string;
  sessionId: string;
  callId: string;
  eventId: string;
  eventType: "participant_joined" | "participant_left" | "room_finished";
  occurredAt: number | null;
  participantIdentity?: string;
};
type SignedJoins = {
  visitor?: { at: number; eventId: string };
  operator?: { at: number; eventId: string };
};
const OUTBOX_RETRY_MS = 1_000;

/** One SQLite-backed Durable Object serializes every pilot call for a tenant. */
export class TenantCallCoordinatorDO {
  private draining: Promise<void> | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  private session(tenantId: string, sessionId: string) {
    return this.env.SESSION.get(this.env.SESSION.idFromName(`${tenantId}:${sessionId}`));
  }

  private sessionFetch(tenantId: string, sessionId: string, path: string, init: RequestInit = {}) {
    return this.session(tenantId, sessionId).fetch(`https://do${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        [DO_INTERNAL_HEADER]: doInternalSecret(this.env),
      },
    });
  }

  private async cloud(path: string, body: unknown): Promise<Response> {
    if (!this.env.API_ORIGIN || !this.env.PUSH_TRIGGER_SECRET)
      return Response.json({ error: "offer_sender_unavailable" }, { status: 503 });
    const url = new URL(path, this.env.API_ORIGIN);
    return fetch(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-push-secret": this.env.PUSH_TRIGGER_SECRET,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
  }

  private async read(): Promise<CoordinatorState | null> {
    return (await this.state.storage.get<CoordinatorState>(COORDINATOR_STATE_KEY)) ?? null;
  }

  private async mutate(tenantId: string, command: CallCommand) {
    return this.state.storage.transaction(async (tx) => {
      const prior = await tx.get<CoordinatorState>(COORDINATOR_STATE_KEY);
      if (prior && prior.tenantId !== tenantId) throw new Error("coordinator_tenant_mismatch");
      const state = prior ?? createCoordinatorState(tenantId, { maxPending: 2 });
      const result = applyCallCommand(state, command);
      await tx.put(COORDINATOR_STATE_KEY, result.state);
      return result.result;
    });
  }

  private async acknowledge(key: string) {
    await this.state.storage.transaction(async (tx) => {
      const state = await tx.get<CoordinatorState>(COORDINATOR_STATE_KEY);
      if (state?.outbox[key])
        await tx.put(COORDINATOR_STATE_KEY, acknowledgeCallOutbox(state, key));
    });
  }

  private async applySignedJoins(tenantId: string, callId: string): Promise<void> {
    const evidence = await this.state.storage.get<SignedJoins>(`signedJoins:${callId}`);
    if (!evidence?.visitor || !evidence.operator) return;
    const state = await this.read();
    const call = state?.calls[callId];
    if (!call || call.status !== "accepted" || call.mediaConnectedAt || !call.winner) return;
    const observed = await observeCallRoom(
      {
        url: this.env.LIVEKIT_URL,
        apiKey: this.env.LIVEKIT_API_KEY,
        apiSecret: this.env.LIVEKIT_API_SECRET,
      },
      callId,
    );
    // Two delayed signed joins prove each peer became active, while this room
    // query proves they overlap. Sequential joins alone do not prove a call.
    if (observed !== "both_active") return;
    await this.mutate(tenantId, {
      type: "media_joined",
      callId,
      eventId: `signed-joined:${callId}`,
      now: Date.now(),
      occurredAt: Math.max(evidence.visitor.at, evidence.operator.at),
      source: "signed_livekit_event",
      operator: { tenantId, ...call.winner },
    });
  }

  private async scheduleAlarm() {
    const state = await this.read();
    if (!state) return;
    const due: number[] = [];
    if (Object.keys(state.outbox).length) due.push(Date.now() + OUTBOX_RETRY_MS);
    for (const call of Object.values(state.calls)) {
      if (call.status === "waiting" || call.status === "ringing") due.push(call.expiresAt);
      if (call.status === "accepted") {
        if (!call.mediaConnectedAt && call.joinDueAt)
          due.push(Math.min(call.joinDueAt, Date.now() + 2_000));
        if (call.mediaConnectedAt) due.push(Date.now() + 10_000);
        due.push((call.acceptedAt ?? call.createdAt) + CALL_MAX_DURATION_MS);
      }
    }
    if (due.length) await this.state.storage.setAlarm(Math.min(...due));
    else await this.state.storage.deleteAlarm();
  }

  private async effect(event: CallOutboxEvent): Promise<boolean> {
    const state = await this.read();
    const call = state?.calls[event.callId];
    if (!state || !call) return true;
    if (event.kind === "status") {
      const authority = await this.sessionFetch(
        state.tenantId,
        call.sessionId,
        `/call/authority?id=${encodeURIComponent(call.callId)}`,
        { headers: { "x-call-actor": "operator" } },
      );
      if (!authority.ok) return false;
      const owner = (await authority.json()) as {
        owner?: string;
        ownerVersion?: number;
        current?: boolean;
      };
      if (owner.owner !== "coordinator" || !owner.ownerVersion) return false;
      if (owner.current) {
        const projected = await this.sessionFetch(state.tenantId, call.sessionId, "/call/project", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callId: call.callId, version: owner.ownerVersion, call }),
        });
        if (!projected.ok && projected.status !== 409) return false;
      }
      const signal = await this.cloud("/internal/native-calls/status-changed", {
        tenantId: state.tenantId,
        callId: call.callId,
        sessionId: call.sessionId,
        revision: event.revision,
        eventId: event.key,
        deviceInstanceIds: callSignalDeviceInstanceIds(call),
      });
      if (!signal.ok) return false;
      const acknowledgement = (await signal.json().catch(() => null)) as {
        acknowledged?: boolean;
      } | null;
      return acknowledgement?.acknowledged === true;
    }
    if (event.kind === "receipt") {
      const receipt = state.timelineReceipts[call.callId];
      if (!receipt) return true;
      const response = await this.sessionFetch(state.tenantId, call.sessionId, "/call/receipt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: state.tenantId, receipt }),
      });
      return response.ok;
    }
    if (event.kind === "close_room") {
      const closed = await closeCallRoom(
        {
          url: this.env.LIVEKIT_URL,
          apiKey: this.env.LIVEKIT_API_KEY,
          apiSecret: this.env.LIVEKIT_API_SECRET,
        },
        `krispy-${call.callId}`,
      );
      if (!closed) return false;
      await this.mutate(state.tenantId, {
        type: "media_ended",
        callId: call.callId,
        eventId: `closed:${event.key}`,
        now: Date.now(),
        source: "close_room_response",
      });
      return true;
    }
    if (event.kind === "dispatch") {
      if (call.status !== "waiting" || call.expiresAt <= Date.now()) return true;
      const response = await this.cloud("/internal/native-calls/eligible-devices", {
        tenantId: state.tenantId,
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { devices?: CloudDevice[] };
      if (!Array.isArray(body.devices) || !body.devices.length) return false;
      for (const device of body.devices) {
        if (!device?.operatorId || !device.deviceInstanceId || device.platform !== "ios") continue;
        const operator: VerifiedCallOperator = {
          tenantId: state.tenantId,
          operatorId: device.operatorId,
          deviceInstanceId: device.deviceInstanceId,
        };
        await this.mutate(state.tenantId, {
          type: "offer",
          callId: call.callId,
          eventId: `dispatch:${event.key}:${device.deviceInstanceId}`,
          now: Date.now(),
          operator,
        });
      }
      return true;
    }
    if (event.kind === "offer") {
      if (!event.deviceInstanceId) return true;
      const offer = state.offers[event.deviceInstanceId];
      if (
        !offer ||
        !offerStillValid(
          state,
          {
            tenantId: state.tenantId,
            callId: call.callId,
            operatorId: offer.operatorId,
            deviceInstanceId: event.deviceInstanceId,
            offerId: event.key,
            expiresAt: call.expiresAt,
          },
          Date.now(),
        )
      )
        return true;
      const response = await this.cloud("/internal/native-calls/offer", {
        tenantId: state.tenantId,
        callId: call.callId,
        sessionId: call.sessionId,
        operatorId: offer.operatorId,
        deviceInstanceId: offer.deviceInstanceId,
        offerId: event.key,
        revision: event.revision,
        expiresAt: call.expiresAt,
        callerLabel: this.env.CALL_PUBLIC_LABEL || "Buttr call",
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { delivered?: boolean; reason?: string };
      if (body.delivered) return true;
      if (body.reason === "provider_retry") return false;
      if (body.reason === "unavailable" || body.reason === "expired") {
        await this.mutate(state.tenantId, {
          type: "decline_offer",
          callId: call.callId,
          eventId: `undelivered:${event.key}`,
          now: Date.now(),
          operator: {
            tenantId: state.tenantId,
            operatorId: offer.operatorId,
            deviceInstanceId: offer.deviceInstanceId,
          },
        });
        return true;
      }
      return false;
    }
    if (event.kind === "stop_offer") {
      if (!event.deviceInstanceId) return true;
      const response = await this.cloud("/internal/native-calls/stop-offer", {
        tenantId: state.tenantId,
        callId: call.callId,
        deviceInstanceId: event.deviceInstanceId,
        stopId: event.key,
        revision: event.revision,
      });
      return response.ok;
    }
    return true;
  }

  private async drainOutbox(limit = 12): Promise<void> {
    if (this.draining) return this.draining;
    const task = (async () => {
      const attempted = new Set<string>();
      for (let i = 0; i < limit; i++) {
        const state = await this.read();
        const event =
          state &&
          Object.values(state.outbox).find(
            (entry) =>
              !attempted.has(entry.key) &&
              ["status", "close_room", "receipt", "stop_offer", "dispatch", "offer"].includes(
                entry.kind,
              ),
          );
        if (!event) break;
        attempted.add(event.key);
        let done = false;
        try {
          done = await this.effect(event);
        } catch {
          done = false;
        }
        if (done) await this.acknowledge(event.key);
      }
    })();
    this.draining = task;
    try {
      await task;
    } finally {
      if (this.draining === task) this.draining = null;
    }
  }

  async alarm(): Promise<void> {
    const before = await this.read();
    if (before) {
      for (const call of Object.values(before.calls)) {
        if (call.status !== "accepted" || !call.winner) continue;
        await this.applySignedJoins(before.tenantId, call.callId);
        const current = (await this.read())?.calls[call.callId] ?? call;
        const observation = await observeCallRoom(
          {
            url: this.env.LIVEKIT_URL,
            apiKey: this.env.LIVEKIT_API_KEY,
            apiSecret: this.env.LIVEKIT_API_SECRET,
          },
          call.callId,
        );
        if (
          observation === "both_active" &&
          !current.mediaConnectedAt &&
          (!current.joinDueAt || Date.now() < current.joinDueAt)
        ) {
          await this.mutate(before.tenantId, {
            type: "media_joined",
            callId: call.callId,
            eventId: `room-present:${call.callId}`,
            now: Date.now(),
            operator: {
              tenantId: before.tenantId,
              operatorId: call.winner.operatorId,
              deviceInstanceId: call.winner.deviceInstanceId,
            },
            source: "verified_room_query",
          });
        } else if (observation === "room_absent" && current.mediaConnectedAt) {
          await this.mutate(before.tenantId, {
            type: "media_ended",
            callId: call.callId,
            eventId: `room-absent:${call.callId}`,
            now: Date.now(),
            source: "verified_room_absent",
          });
        }
      }
    }
    await this.state.storage.transaction(async (tx) => {
      const current = await tx.get<CoordinatorState>(COORDINATOR_STATE_KEY);
      if (current)
        await tx.put(
          COORDINATOR_STATE_KEY,
          pruneCoordinatorState(expireCoordinatedCalls(current, Date.now()), Date.now()),
        );
    });
    await this.drainOutbox();
    await this.scheduleAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get(DO_INTERNAL_HEADER) !== doInternalSecret(this.env))
      return Response.json({ error: "system_auth_required" }, { status: 403 });
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/signed-webhook") {
      const body = (await request.json().catch(() => null)) as SignedWebhook | null;
      const state = await this.read();
      const call = body && state?.tenantId === body.tenantId ? state.calls[body.callId] : null;
      if (
        !body ||
        !call ||
        call.sessionId !== body.sessionId ||
        !/^[0-9a-f-]{36}$/i.test(body.eventId)
      )
        return Response.json({ error: "call_not_found" }, { status: 404 });
      if (body.eventType === "participant_joined") {
        const role =
          body.participantIdentity === `visitor-${body.callId}`
            ? "visitor"
            : body.participantIdentity === `operator-${body.callId}`
              ? "operator"
              : null;
        if (role && body.occurredAt !== null && Number.isSafeInteger(body.occurredAt)) {
          await this.state.storage.transaction(async (tx) => {
            const key = `signedJoins:${body.callId}`;
            const prior = (await tx.get<SignedJoins>(key)) ?? {};
            const current = prior[role];
            if (!current || body.occurredAt! < current.at)
              await tx.put(key, {
                ...prior,
                [role]: { at: body.occurredAt, eventId: body.eventId },
              });
          });
          await this.applySignedJoins(body.tenantId, body.callId);
        }
      } else if (body.eventType === "room_finished") {
        await this.mutate(body.tenantId, {
          type: "media_ended",
          callId: body.callId,
          eventId: `livekit:${body.eventId}`,
          now: Date.now(),
          source: "signed_room_finished",
          ...(body.occurredAt !== null ? { occurredAt: body.occurredAt } : {}),
        });
      }
      await this.drainOutbox();
      await this.scheduleAlarm();
      return Response.json({ acknowledged: true });
    }
    if (request.method === "POST" && path === "/command") {
      const body = (await request.json().catch(() => null)) as CommandBody | null;
      if (
        !body?.tenantId ||
        !body.command ||
        typeof body.command !== "object" ||
        typeof body.command.type !== "string" ||
        !body.command.eventId
      )
        return Response.json({ error: "invalid_command" }, { status: 400 });
      let result;
      try {
        result = await this.mutate(body.tenantId, body.command);
      } catch {
        return Response.json({ error: "invalid_command" }, { status: 400 });
      }
      await this.drainOutbox();
      await this.scheduleAlarm();
      return Response.json(result);
    }
    if (request.method === "GET" && path === "/state") {
      const state = await this.read();
      if (!state) return Response.json({ error: "call_not_found" }, { status: 404 });
      return Response.json({ state });
    }
    if (request.method === "GET" && path === "/call-route") {
      const callId = new URL(request.url).searchParams.get("id");
      const state = await this.read();
      const call = callId ? state?.calls[callId] : null;
      return call
        ? Response.json({ tenantId: state!.tenantId, sessionId: call.sessionId })
        : Response.json({ error: "call_not_found" }, { status: 404 });
    }
    if (request.method === "POST" && path === "/offer-validity") {
      const body = (await request.json().catch(() => null)) as
        | Parameters<typeof offerStillValid>[1]
        | null;
      const state = await this.read();
      return Response.json({
        valid: !!body && !!state && offerStillValid(state, body, Date.now()),
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
