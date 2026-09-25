# Staged operator call coordinator

This design is **off**. Runtime 0.4 continues to use the existing `/api/call`,
`/api/operator/call`, and `SessionDO` paths. `call-coordinator-model.ts` and
`call-coordinator-adapter.ts` are testable source for a future runtime 0.5 route;
no route, Durable Object binding, secret, or migration is registered yet.

## Authority and storage

- Register a new `TenantCallCoordinatorDO` under a `CALL_COORDINATOR` binding only
  when the complete runtime 0.5 path is ready. Address it by server-resolved
  owner tenant ID (`idFromName(tenantId)`), so businesses do not serialize each
  other. Do not derive the tenant from the request body.
- The coordinator is authoritative for call status, one outstanding offer per
  operator, one winning installation, and occupied/ending state. `SessionDO` is a
  projection for the visitor and operator transcript, never the accept arbiter.
- One storage transaction reads `coordinator:v1`, applies one reducer command,
  and persists the new state and outbox together. Network calls and push sends
  happen after commit. A failed projection or push leaves the outbox event for
  retry; duplicate `actionEventId` gets its saved disposition plus current status
  and revision. Prune only terminal calls older than seven days whose outbox is
  acknowledged. Never prune active, ringing, queued, or ending calls.
- A 60-second original visitor deadline bounds a request even while queued.
  A 30-second accepted-but-not-joined deadline enters `ending`; occupancy is
  released only after a signed LiveKit room-finished event, a verified room-absent
  query, or confirmed room deletion. A client callback is not closure proof.
  Retried room close must be idempotent. Native timeout after an accepted claim
  sends a new deterministic End event and does not join audio.
- Every terminal call emits one `CallTimelineReceipt` outbox effect. SessionDO
  checks stored tenant and session, writes the receipt by callId in one storage
  transaction, and broadcasts only on the first write. The receipt remains
  outside the bounded chat ring and is returned separately in operator thread
  reads and guest/operator socket replay. `connectedAt` requires both LiveKit
  participants; `connectedDurationMs` ends at verified media termination, not
  invitation or acceptance. `endTimeProvenance` distinguishes signed exact
  events from later room-absent observation. It contains no recording or chat
  summary. Coordinator retention can prune its projected copy after outbox ack;
  SessionDO retains the transcript copy.

## Identity and rollout

- The Cloud API resolves the current Better Auth user, owner tenant, accepted
  membership, registered capable installation UUID, session validity, and call
  availability. A background/closed app is still eligible when native push and
  its calling credential are valid. Foreground WebSocket presence alone is not
  an availability test. Focus/DND or rejected delivery excludes that device for
  the current call, then dispatches another eligible operator while retaining
  the visitor's original deadline.
- The edge adapter validates UUID call IDs, bounded action event IDs (including
  deterministic `late-accept:<uuid>`, `media-failed:<uuid>`,
  `late-audio:<uuid>`, `unsafe-stop:<uuid>`, and `late-start:<uuid>` follow-ups), and opaque session IDs of at
  most 200 characters. It constructs model commands from the verified identity,
  ignoring actor IDs in request JSON. A system-only room closure route must
  authenticate its sender and independently verify LiveKit evidence before
  applying `media_ended`; a TypeScript `source` string is not proof.
- The future route must require an explicit tenant/runtime feature flag and a
  runtime 0.5-capable device. Leave the flag off through old binary migration.
  Runtime 0.4 routes, grants, and active rooms are not transferred into the new
  object. The two paths must not offer the same call simultaneously.
- Native push carries opaque call/session IDs, account routing hint, approved
  public caller label, original expiry, and revision. It carries no media grant,
  chat text, lead fields, or credential. A losing device stops only its own UI;
  it cannot end the winning call. The winning device alone can obtain a grant.

## Locked-phone calling credential (proposal; unimplemented)

Keep the main Better Auth bearer in SecureStore `WHEN_UNLOCKED` and keep biometric
policy unchanged. After unlocked full authentication, issue a random opaque
call-only refresh credential bound in the Cloud database to the real user,
owner tenant, installation UUID, and current auth session. The native app may
store it using `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`; never put it in push, URL,
or logs. A locked cold launch exchanges it for a five-minute access credential
limited to call status/action and winning-device media grant. The refresh hard
cap is 30 days, but its effective expiry is the **current Better Auth session
expiry**, membership/device validity, or 30 days, whichever comes first. The
repo does not override Better Auth 1.6's default seven-day session lifetime;
call-only refresh must not silently extend that broader session. The app should
show expired registration and prompt for normal re-authentication on next open,
and the server must not offer an unreachable expired device.

Store only a hash of the refresh secret. Rotate atomically with a request ID;
allow a bounded replay of the same rotation response so a crash after server
commit does not strand the app, then revoke the previous secret. Recheck session,
membership, and device before refresh and each action. Revoke on signout,
account switch, membership removal, and deregistration, and delete locally
before switching. Offline local deletion cannot instantly revoke a copied server
credential; queue revocation and fail the next server check when the underlying
session is no longer valid. No credential table or persistent key is added yet.

## Busy/timeout contact route

The coordinator returns `operator_busy`, `expired`, or `unavailable` without an
invented wait estimate or callback promise. Resolve the session's stored site,
read its current tenant config, and expose only `publicWidgetConfig` forms and
visitor-facing CTAs through `configuredCallFallback`. If none are configured,
`fallbackAvailable` is false. A selected form uses the existing typed lead path,
which persists the fields and recent conversation for the operator; no visitor
contact details appear in call push. The pending human inquiry remains in the
inbox until a team member resolves it.
