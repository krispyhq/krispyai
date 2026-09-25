// SessionDO — one Durable Object per (tenant, session). Two jobs:
//   1. Hibernatable WebSocket fan-out (state.acceptWebSocket) → pushes operator
//      replies to the visitor's browser with ZERO idle billing.
//   2. The strongly-consistent handoff state — `pending` as soon as a human is
//      requested, `operator` after their first reply, and `ai` after handback.
//
// Internal HTTP surface (called by the Worker, never the browser directly):
//   GET  (Upgrade: websocket)  → visitor connects; gets {type:"ready", handoffState, handedOff}
//                                (?role=operator tags the socket — Buttr app, §3d)
//   GET  /state                → { handoffState, handedOff }   (chat's fallback path)
//   GET  /context              → { handoffState, handedOff, messages }  (one combined read — the chat
//                                flow's authoritative memory + handoff flag per turn)
//   GET  /summary              → { handoffState, handedOff, resolved, lastMessage, ts, siteId }
//   GET  /identity             → { tenantId, siteId } (operator action scope check)
//   GET  /log                  → { messages }    (the 20-msg ring — thread read)
//   POST /log {messages,seed?} → append to the ring (seed: only if the ring is empty)
//   POST /operator {text}      → set operator state, broadcast + ring-append operator reply
//                                (also cancels the silence hand-back alarm)
//   POST /action {action}      → append a resolved form/Instagram card and broadcast it
//   POST /handoff              → broadcast a handoff prompt (AI escalation)
//   POST /resolve {resolved?}  → toggle (or force-set) the `resolved` flag (operator
//                                inbox hygiene); resolving ALSO hands the session back
//                                to the AI (`ai` + {type:"resume"} broadcast).
//                                A new LIVE visitor message un-resolves automatically
//                                but does NOT re-hand-off (the bot answers).
//
// Silence hand-back: a visitor message while pending/operator-owned arms the DO alarm
// (HANDBACK_SILENCE_MINUTES, default 5). An operator reply disarms it. If it fires,
// the session hands back to the AI so a returning visitor never faces a muted bot.
import type { Env, HandoffState, OperatorAction, ServerEvent, SessionMessage } from "./types";
import { DO_INTERNAL_HEADER, doInternalSecret, readTenantConfig } from "./store";
import { proposeKbSuggestion } from "./learn";
import {
  currentCall,
  inviteCall,
  publicCall,
  transitionCall,
  type CallState,
  type CallAction,
  CALL_MAX_DURATION_MS,
} from "./call";
import { closeCallRoom, issueCallToken } from "./call-token";

interface Sendable {
  send(data: string): void;
}

/** Pure fan-out: send an event to every socket, ignoring dead ones. Unit-tested. */
export function broadcast(sockets: Sendable[], event: ServerEvent): number {
  const payload = JSON.stringify(event);
  let delivered = 0;
  for (const ws of sockets) {
    try {
      ws.send(payload);
      delivered++;
    } catch {
      /* dead socket — the runtime prunes it */
    }
  }
  return delivered;
}

// ── message ring buffer (operator-app thread read + inbox preview) ───────────
// The last RING_MAX turns of the session, mirrored here by the Worker (visitor msg,
// AI reply) and by the /operator path (operator reply) — so the Buttr app can read a
// thread with zero Telegram round-trips.
// ponytail: 20-msg ceiling; add pagination only when a thread needs scroll-back
export const RING_MAX = 20;
export type RingMsg = SessionMessage;

/** The first frame after every WS reconnect carries the durable ring snapshot.
 * Clients may have been backgrounded while a reply arrived, so the live event
 * alone cannot be the source of truth after reconnect. */
export function readyEvent(handoffState: HandoffState, messages: RingMsg[]): ServerEvent {
  return {
    type: "ready",
    handoffState,
    handedOff: handoffState === "operator",
    messages: messages.slice(-RING_MAX),
  };
}

// ── silence hand-back (DO alarm) ─────────────────────────────────────────────
// Operator silence after a visitor message on a handed-off session → hand back to
// the AI. Minutes are env-tunable (HANDBACK_SILENCE_MINUTES); this is the default.
export const HANDBACK_SILENCE_MINUTES = 5;
// Bot-styled ring line appended on a silence hand-back (operator thread record).
export const HANDBACK_NOTE = "No reply from the team for a while — the AI has resumed this chat.";

export class SessionDO {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /** Read the new enum, with a no-migration interpretation of the two legacy flags. */
  private async handoffState(): Promise<HandoffState> {
    const stored = await this.state.storage.get<HandoffState>("handoffState");
    if (stored === "ai" || stored === "pending" || stored === "operator") return stored;
    if ((await this.state.storage.get<boolean>("handedOff")) === true) return "operator";
    if ((await this.state.storage.get<boolean>("handoffAnnounced")) === true) return "pending";
    return "ai";
  }

  /** Keep handedOff as the backwards-compatible "operator replied" boolean. */
  private async setHandoffState(next: HandoffState): Promise<void> {
    await Promise.all([
      this.state.storage.put("handoffState", next),
      this.state.storage.put("handedOff", next === "operator"),
    ]);
  }

  private async resolved(): Promise<boolean> {
    return (await this.state.storage.get<boolean>("resolved")) === true;
  }

  private async ring(): Promise<RingMsg[]> {
    return (await this.state.storage.get<RingMsg[]>("log")) ?? [];
  }

  private async callState(): Promise<CallState | null> {
    const stored = await this.state.storage.get<CallState>("call");
    const current = currentCall(stored, Date.now());
    if (current && current !== stored) {
      await this.state.storage.put("call", current);
      await this.sendCall(current);
      if (stored?.status === "accepted") await this.closeEndedRoom(stored.room);
      await this.scheduleAlarm();
    }
    return current;
  }

  private rtcConfig() {
    return {
      url: this.env.LIVEKIT_URL,
      apiKey: this.env.LIVEKIT_API_KEY,
      apiSecret: this.env.LIVEKIT_API_SECRET,
    };
  }

  private async closeEndedRoom(room: string): Promise<boolean> {
    const closed = await closeCallRoom(this.rtcConfig(), room);
    if (closed) {
      await this.state.storage.put("callCleanupRoom", "");
      await this.state.storage.put("callCleanupDueAt", 0);
    } else {
      await this.state.storage.put("callCleanupRoom", room);
      await this.state.storage.put("callCleanupDueAt", Date.now() + 30_000);
    }
    return closed;
  }

  /** One platform alarm serves handback, invitation expiry, call limit, and cleanup. */
  private async scheduleAlarm(): Promise<void> {
    const call = await this.state.storage.get<CallState>("call");
    const handoffDue = await this.state.storage.get<number>("handoffDueAt");
    const cleanupDue = await this.state.storage.get<number>("callCleanupDueAt");
    const callDue =
      call?.status === "ringing"
        ? call.expiresAt
        : call?.status === "accepted"
          ? (call.acceptedAt ?? call.createdAt) + CALL_MAX_DURATION_MS
          : 0;
    const due = [handoffDue, callDue, cleanupDue].filter(
      (n): n is number => typeof n === "number" && n > 0,
    );
    if (due.length) await this.state.storage.setAlarm(Math.min(...due));
    else await this.state.storage.deleteAlarm();
  }

  private async sendCall(call: CallState | null): Promise<void> {
    const basic = publicCall(call, Date.now());
    broadcast(this.state.getWebSockets("operator"), { type: "call", call: basic });
    const nonce = await this.state.storage.get<string>("callNonce");
    broadcast(this.state.getWebSockets("call-visitor"), { type: "call", call: basic, nonce });
  }

  private async appendRing(msgs: RingMsg[]): Promise<RingMsg[]> {
    const log = await this.ring();
    log.push(...msgs);
    while (log.length > RING_MAX) log.shift();
    await this.state.storage.put("log", log);
    return log;
  }

  private silenceMs(): number {
    const mins = Number(this.env.HANDBACK_SILENCE_MINUTES);
    return (Number.isFinite(mins) && mins > 0 ? mins : HANDBACK_SILENCE_MINUTES) * 60_000;
  }

  /** Hand the session back to the AI: clear pending/operator state, disarm the silence alarm,
   * broadcast {type:"resume"} to every socket (widget un-mutes its framing; the
   * Buttr thread sees the state flip). No-op when the bot already has the session. */
  private async handBack(opts: { note?: string } = {}): Promise<void> {
    await this.state.storage.put("handoffDueAt", 0);
    await this.scheduleAlarm();
    // Reset the handoff-announce guard so a genuinely new future escalation can alert
    // again (see /handoff). Cleared for both pending and operator-owned sessions.
    await this.state.storage.put("handoffAnnounced", false);
    if ((await this.handoffState()) === "ai") return;
    await this.setHandoffState("ai");
    if (opts.note) await this.appendRing([{ role: "ai", text: opts.note, ts: Date.now() }]);
    broadcast(this.state.getWebSockets(), { type: "resume", handoffState: "ai" });
    await this.maybeLearn();
  }

  /** Relearning: on a real handback (operator had the session), extract a Q→A the human
   * answered into a knowledge suggestion. OFF BY DEFAULT — the tenant opts in by using the
   * knowledge base (≥1 kbSource); a tenant that never touched the KB feature incurs ZERO
   * billable AI on handback and behaves exactly as before this feature (HARD RULE 1). Also
   * gated on ≥1 operator message so a bot-only handback stays silent. Awaited (not
   * fire-and-forget) so the write completes before the DO can be evicted — the alarm path
   * has no request keeping it alive — but every failure is swallowed: relearning must NEVER
   * break resolve/handback.
   * ponytail: opt-in signal is kbSources presence (fresh KV read on the rare handback path,
   * no duplicated flag) — add an explicit `relearnEnabled` toggle only if a tenant wants
   * knowledge WITHOUT auto-suggestions. One AI call per handback, synchronous on the resolve
   * path (adds ~1s to an operator's resolve tap — acceptable for inbox hygiene). Learns only
   * from operator-touched sessions; bot-wrong/visitor-gave-up sessions are silent (upgrade
   * path is unanswered-question detection + thumbs-down feedback into the same inbox). */
  private async maybeLearn(): Promise<void> {
    try {
      const log = await this.ring();
      if (!log.some((m) => m.role === "operator")) return;
      const tenantId = await this.state.storage.get<string>("tenantId");
      if (!tenantId) return; // never learned its identity (no /context POST) — skip
      const siteId = await this.state.storage.get<string>("siteId");
      // Opt-in gate: relearning runs only for tenants using the KB feature. No kbSources →
      // no AI call, no suggestion write — off by default for every operator-only tenant.
      const cfg = await readTenantConfig(this.env, tenantId, siteId);
      if (!cfg?.kbSources?.length) return;
      // Bound the AI latency — a DO alarm has no ctx.waitUntil, so this runs on the
      // resolve/handback path; a hung Workers-AI call must not block the operator. Race
      // it against an 8s timeout (extraction is a small single call; slower = give up).
      await Promise.race([
        proposeKbSuggestion(this.env, tenantId, siteId, log),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
    } catch (e) {
      console.error("relearning failed (best-effort):", e);
    }
  }

  /** Process only the deadlines that have elapsed, then schedule the next one. */
  async alarm(): Promise<void> {
    await this.callState();
    const now = Date.now();
    const handoffDue = await this.state.storage.get<number>("handoffDueAt");
    if (handoffDue && handoffDue <= now) await this.handBack({ note: HANDBACK_NOTE });
    const cleanupDue = await this.state.storage.get<number>("callCleanupDueAt");
    const cleanupRoom = await this.state.storage.get<string>("callCleanupRoom");
    if (cleanupDue && cleanupDue <= now && cleanupRoom) await this.closeEndedRoom(cleanupRoom);
    await this.scheduleAlarm();
  }

  /** The internal (Worker-only) HTTP surface is state-mutating — require the shared
   * secret so only our Worker can flip handoff / broadcast. The WS upgrade stays open
   * (the session id is the capability the browser holds). */
  private internalAuthed(request: Request): boolean {
    return request.headers.get(DO_INTERNAL_HEADER) === doInternalSecret(this.env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      // ?role=operator tags the socket (Buttr operator app, §3d) so the DO can
      // distinguish operator sockets (state.getWebSockets("operator")). Broadcast
      // already fans every ServerEvent to every socket, so an operator socket gets
      // the full union today; the tag is what lets operator-only events exist later.
      const operator = url.searchParams.get("role") === "operator";
      const visitorSecret = url.searchParams.get("v");
      const registered = await this.state.storage.get<string>("callVisitorSecret");
      const callVisitor = !operator && !!registered && visitorSecret === registered;
      this.state.acceptWebSocket(
        server,
        operator ? ["operator"] : callVisitor ? ["call-visitor"] : undefined,
      ); // hibernatable — no idle billing
      const handoffState = await this.handoffState();
      const event = readyEvent(handoffState, await this.ring());
      try {
        server.send(JSON.stringify(event));
        if (operator || callVisitor) {
          const call = publicCall(await this.callState(), Date.now());
          const nonce = callVisitor ? await this.state.storage.get<string>("callNonce") : undefined;
          server.send(JSON.stringify({ type: "call", call, nonce }));
        }
      } catch {
        /* noop */
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    // Everything past the WS upgrade is the internal Worker→DO surface — gated.
    if (!this.internalAuthed(request)) return new Response("forbidden", { status: 403 });

    if (request.method === "POST" && url.pathname.endsWith("/call/visitor/register")) {
      const body = (await request.json().catch(() => ({}))) as { secret?: string };
      if (!body.secret || !/^[A-Za-z0-9_-]{43}$/.test(body.secret))
        return Response.json({ error: "invalid_secret" }, { status: 400 });
      const registered = await this.state.storage.get<string>("callVisitorSecret");
      if (!registered) await this.state.storage.put("callVisitorSecret", body.secret);
      return Response.json({ ok: !registered || registered === body.secret });
    }

    if (request.method === "POST" && url.pathname.endsWith("/call/grant")) {
      const actor = request.headers.get("x-call-actor");
      const registered = await this.state.storage.get<string>("callVisitorSecret");
      if (actor !== "operator" && actor !== "visitor")
        return Response.json({ error: "actor_required" }, { status: 403 });
      if (
        actor === "visitor" &&
        (!registered || request.headers.get("x-call-visitor-secret") !== registered)
      )
        return Response.json({ error: "visitor_auth_required" }, { status: 403 });
      const body = (await request.json().catch(() => ({}))) as { id?: string };
      if (!body.id) return Response.json({ error: "stale_call" }, { status: 409 });
      const rtc = {
        url: this.env.LIVEKIT_URL,
        apiKey: this.env.LIVEKIT_API_KEY,
        apiSecret: this.env.LIVEKIT_API_SECRET,
      };
      const call = await this.callState();
      if (!call) return Response.json({ error: "call_not_accepted" }, { status: 409 });
      const grant = await issueCallToken(rtc, call, body.id, actor);
      const afterSigning = await this.callState();
      if (!grant || afterSigning?.status !== "accepted" || afterSigning.id !== body.id)
        return Response.json({ error: "call_not_accepted" }, { status: 409 });
      return Response.json(grant);
    }

    if (url.pathname.endsWith("/call")) {
      const body =
        request.method === "POST"
          ? ((await request.json().catch(() => ({}))) as {
              action?: "invite" | CallAction;
              id?: string;
              nonce?: string;
              visitorSecret?: string;
            })
          : null;
      const actor = request.headers.get("x-call-actor");
      const visitorSecret = await this.state.storage.get<string>("callVisitorSecret");
      if (
        actor === "visitor" &&
        (!visitorSecret || request.headers.get("x-call-visitor-secret") !== visitorSecret)
      ) {
        return Response.json({ error: "visitor_auth_required" }, { status: 403 });
      }
      if (actor !== "visitor" && actor !== "operator")
        return Response.json({ error: "actor_required" }, { status: 403 });
      if (request.method === "GET") {
        const call = await this.callState();
        return Response.json({
          call: publicCall(call, Date.now()),
          ...(actor === "visitor"
            ? { nonce: await this.state.storage.get<string>("callNonce") }
            : {}),
        });
      }
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const action = body?.action;
      if (action === "invite") {
        if (
          actor !== "operator" ||
          !visitorSecret ||
          this.state.getWebSockets("call-visitor").length === 0
        )
          return Response.json({ error: "visitor_unavailable" }, { status: 409 });
        if (await this.state.storage.get<string>("callCleanupRoom"))
          return Response.json({ error: "previous_call_cleanup_pending" }, { status: 503 });
        const result = inviteCall(await this.callState(), Date.now());
        if (!result.ok) return Response.json({ error: result.reason }, { status: 409 });
        if (result.changed) {
          await this.state.storage.put("call", result.call);
          await this.state.storage.put("callNonce", crypto.randomUUID());
          await this.sendCall(result.call);
          await this.scheduleAlarm();
        }
        return Response.json({ call: publicCall(result.call, Date.now()) });
      }
      if (!action || !body?.id) return Response.json({ error: "invalid_action" }, { status: 400 });
      if ((action === "accept" || action === "decline") && actor !== "visitor")
        return Response.json({ error: "wrong_actor" }, { status: 403 });
      if (action === "cancel" && actor !== "operator")
        return Response.json({ error: "wrong_actor" }, { status: 403 });
      if (actor === "visitor" && body.nonce !== (await this.state.storage.get<string>("callNonce")))
        return Response.json({ error: "invalid_nonce" }, { status: 403 });
      const result = transitionCall(await this.callState(), action, Date.now(), body.id);
      if (!result.ok) return Response.json({ error: result.reason }, { status: 409 });
      if (result.changed) {
        await this.state.storage.put("call", result.call);
        await this.sendCall(result.call);
        await this.scheduleAlarm();
      }
      if (action === "end") {
        const closed = await this.closeEndedRoom(result.call.room);
        await this.scheduleAlarm();
        if (!closed)
          return Response.json(
            { error: "room_disconnect_failed", call: publicCall(result.call, Date.now()) },
            { status: 502 },
          );
      }
      return Response.json({ call: publicCall(result.call, Date.now()), room: result.call.room });
    }

    if (request.method === "GET" && url.pathname.endsWith("/state")) {
      const handoffState = await this.handoffState();
      return Response.json({ handoffState, handedOff: handoffState === "operator" });
    }

    // One combined read for the chat flow: the handoff flag + the ring, so the
    // bot's memory costs the same single subrequest /state used to. POSTed by the chat
    // flow with { tenantId, siteId } so the DO can persist its own identity write-once:
    // the relearning handback fires from an ALARM with no request in flight, and the DO
    // can't derive tenantId/siteId from its own name (siteId isn't even in the name).
    if (url.pathname.endsWith("/context")) {
      if (request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as {
          tenantId?: string;
          siteId?: string;
        };
        if (body.tenantId && !(await this.state.storage.get<string>("tenantId"))) {
          await this.state.storage.put("tenantId", body.tenantId);
          if (body.siteId) await this.state.storage.put("siteId", body.siteId);
        }
      }
      const [handoffState, messages] = await Promise.all([this.handoffState(), this.ring()]);
      return Response.json({
        handoffState,
        handedOff: handoffState === "operator",
        messages,
      });
    }

    // One inbox-row read: handoff flag + the ring tail — halves the per-session
    // subrequests of the /api/operator/handoffs KV scan vs /state + /log.
    if (request.method === "GET" && url.pathname.endsWith("/summary")) {
      const [handoffState, resolved, log] = await Promise.all([
        this.handoffState(),
        this.resolved(),
        this.ring(),
      ]);
      const last = log[log.length - 1];
      return Response.json({
        handoffState,
        handedOff: handoffState === "operator",
        resolved,
        lastMessage: last?.text ?? null,
        ts: last?.ts ?? null,
        siteId: (await this.state.storage.get<string>("siteId")) ?? "default",
      });
    }

    if (request.method === "GET" && url.pathname.endsWith("/identity")) {
      return Response.json({
        tenantId: (await this.state.storage.get<string>("tenantId")) ?? null,
        siteId: (await this.state.storage.get<string>("siteId")) ?? "default",
      });
    }

    if (request.method === "GET" && url.pathname.endsWith("/log")) {
      return Response.json({ messages: await this.ring() });
    }

    if (request.method === "POST" && url.pathname.endsWith("/log")) {
      const { messages, seed } = (await request.json()) as {
        messages?: { role: RingMsg["role"]; text: string; ts?: number }[];
        seed?: boolean;
      };
      // seed=true: the Worker replays the widget's re-sent history on handoff — only
      // when the ring is still empty (per-turn appends normally beat it; the seed
      // covers sessions whose earlier turns predate the ring).
      if (seed && (await this.ring()).length > 0) {
        return Response.json({ ok: true, seeded: false });
      }
      const now = Date.now();
      const appended: RingMsg[] = (messages ?? []).map((m) => ({
        role: m.role,
        text: m.text,
        ts: m.ts ?? now,
      }));
      const log = await this.appendRing(appended);
      // A new LIVE visitor message on a resolved session un-resolves it — the
      // visitor came back, so it belongs in the inbox again. Seed replays are
      // backfill of old turns, not new activity. Un-resolving does NOT re-hand-off:
      // the bot answers, and the visitor can re-request a human normally.
      if (!seed && appended.some((m) => m.role === "visitor")) {
        if (await this.resolved()) await this.state.storage.put("resolved", false);
        // Pending/operator + visitor waiting → arm (or reset) silence hand-back.
        // Any operator reply disarms it (see /operator).
        if ((await this.handoffState()) !== "ai") {
          await this.state.storage.put("handoffDueAt", Date.now() + this.silenceMs());
          await this.scheduleAlarm();
        }
      }
      // Mirror LIVE visitor/AI turns to operator sockets so an open Buttr thread
      // streams in realtime (§3d/§6). Seed replays are backfill (the app reads
      // them via /log) and visitor sockets are untouched — they'd echo the
      // visitor's own text back at them.
      if (!seed) {
        const operators = this.state.getWebSockets("operator");
        for (const m of appended) {
          if (m.role === "operator") continue; // operator replies broadcast via /operator
          broadcast(operators, { type: "message", role: m.role, text: m.text, ts: m.ts });
        }
      }
      return Response.json({ ok: true, size: log.length });
    }

    if (request.method === "POST" && url.pathname.endsWith("/operator")) {
      const { text } = (await request.json()) as { text: string };
      const ts = Date.now();
      await this.setHandoffState("operator");
      await this.state.storage.put("handoffDueAt", 0); // operator replied
      await this.scheduleAlarm();
      await this.appendRing([{ role: "operator", text, ts }]);
      const n = broadcast(this.state.getWebSockets(), {
        type: "operator",
        handoffState: "operator",
        text,
        ts,
      });
      return Response.json({ ok: true, delivered: n });
    }

    if (request.method === "POST" && url.pathname.endsWith("/action")) {
      const { action } = (await request.json()) as { action: OperatorAction };
      const text = action.kind === "form" ? action.form.title : action.connector.label;
      const ts = Date.now();
      await this.setHandoffState("operator");
      await this.state.storage.put("handoffDueAt", 0);
      await this.scheduleAlarm();
      await this.appendRing([{ role: "operator", text, ts, action }]);
      const delivered = broadcast(this.state.getWebSockets(), {
        type: "action",
        handoffState: "operator",
        text,
        ts,
        action,
      });
      return Response.json({ ok: true, delivered });
    }

    // Toggle the resolved flag (operator "done with this one" — inbox hygiene).
    // Toggling (not one-way set) lets the app undo an accidental swipe; a body of
    // { resolved: boolean } force-sets instead (the Telegram /done path — a repeat
    // /done must never accidentally un-resolve). Resolving = hand back to the AI.
    // Un-resolving (undo) does NOT re-hand-off — an operator reply re-takes over.
    if (request.method === "POST" && url.pathname.endsWith("/resolve")) {
      const body = (await request.json().catch(() => null)) as { resolved?: boolean } | null;
      const next = typeof body?.resolved === "boolean" ? body.resolved : !(await this.resolved());
      await this.state.storage.put("resolved", next);
      if (next) await this.handBack();
      return Response.json({ ok: true, resolved: next });
    }

    if (request.method === "POST" && url.pathname.endsWith("/handoff")) {
      // Idempotency guard: a jailbroken bot can emit [!HANDOFF] on every turn. The
      // widget-facing broadcast is harmless to repeat, but the Worker's LOUD side of a
      // handoff (operator @mention + push) must fire ONCE per escalation, not per turn.
      // `announced` tells the Worker whether this is the first time; handBack clears the
      // flag so a later, genuine escalation can alert again. MAX_AI_TURNS bounds the rest.
      const [announced, current] = await Promise.all([
        this.state.storage.get<boolean>("handoffAnnounced").then((value) => value === true),
        this.handoffState(),
      ]);
      if (!announced) await this.state.storage.put("handoffAnnounced", true);
      const handoffState = current === "operator" ? "operator" : "pending";
      if (current === "ai") await this.setHandoffState("pending");
      const n = broadcast(this.state.getWebSockets(), { type: "handoff", handoffState });
      return Response.json({ ok: true, delivered: n, announced: !announced, handoffState });
    }

    return new Response("not found", { status: 404 });
  }

  // ── hibernation handlers (required with acceptWebSocket) ──────────────────
  // Visitors are receive-only; we answer their keepalive ping so proxies don't
  // idle-close the socket. Everything else is ignored.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") {
      try {
        ws.send("pong");
      } catch {
        /* noop */
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code, "closing");
    } catch {
      /* noop */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "error");
    } catch {
      /* noop */
    }
  }
}
