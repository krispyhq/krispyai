import type { CallState } from "./call";
import { canJoinCall } from "./call";

/** A token gates joining; an already connected peer must also disconnect on end. */
export const CALL_TOKEN_TTL_SECONDS = 120;

export interface CallRtcConfig {
  url?: string;
  apiKey?: string;
  apiSecret?: string;
}

export function callRtcAvailable(config: CallRtcConfig): boolean {
  if (!config.apiKey?.trim() || !config.apiSecret?.trim() || !config.url?.trim()) return false;
  try {
    const url = new URL(config.url);
    return (
      url.protocol === "wss:" ||
      (url.protocol === "ws:" && ["localhost", "127.0.0.1"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

function base64url(data: Uint8Array): string {
  let raw = "";
  for (const byte of data) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

async function livekitSigningKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** LiveKit signs the raw webhook body hash inside an HS256 bearer JWT. */
export async function verifyLivekitWebhook(
  config: CallRtcConfig,
  rawBody: string,
  authorization: string | null,
  now = Date.now(),
): Promise<Record<string, unknown> | null> {
  if (!config.apiKey || !config.apiSecret || !authorization || rawBody.length > 32_768) return null;
  const token = authorization.replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const signature = decodeBase64url(signaturePart);
  const headerBytes = decodeBase64url(headerPart);
  const payloadBytes = decodeBase64url(payloadPart);
  if (!signature || !headerBytes || !payloadBytes) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(headerBytes)) as Record<string, unknown>;
    const claims = JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<string, unknown>;
    if (header.alg !== "HS256" || claims.iss !== config.apiKey) return null;
    const nowSeconds = Math.floor(now / 1000);
    if (typeof claims.exp === "number" && claims.exp < nowSeconds) return null;
    if (typeof claims.nbf === "number" && claims.nbf > nowSeconds) return null;
    const key = await livekitSigningKey(config.apiSecret);
    const signatureBytes = new Uint8Array(new ArrayBuffer(signature.byteLength));
    signatureBytes.set(signature);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    if (!valid) return null;
    const digest = base64url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody))),
    );
    // The LiveKit server SDK uses standard base64 for the sha256 claim.
    const standardDigest = digest.replace(/-/g, "+").replace(/_/g, "/").padEnd(44, "=");
    if (claims.sha256 !== standardDigest) return null;
    const event = JSON.parse(rawBody);
    return event && typeof event === "object" && !Array.isArray(event) ? event : null;
  } catch {
    return null;
  }
}

/** WebCrypto keeps the edge Worker dependency-free. Do not expose config to clients. */
async function signClaims(
  config: CallRtcConfig,
  subject: string,
  video: Record<string, unknown>,
  now: number,
  ttl: number,
) {
  const iat = Math.floor(now / 1000);
  const exp = iat + ttl;
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: config.apiKey,
        sub: subject,
        iat,
        nbf: iat,
        exp,
        video,
      }),
    ),
  );
  const unsigned = `${header}.${payload}`;
  const key = await livekitSigningKey(config.apiSecret!);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned)),
  );
  return { token: `${unsigned}.${base64url(signature)}`, expiresAt: exp * 1000 };
}

export async function issueCallToken(
  config: CallRtcConfig,
  call: CallState,
  expectedId: string,
  role: "visitor" | "operator",
  now: number = Date.now(),
): Promise<{ url: string; token: string; expiresAt: number } | null> {
  if (!callRtcAvailable(config) || !canJoinCall(call, expectedId, now)) return null;
  return issueRoomToken(config, call.room, call.id, role, now);
}

/** Caller verifies coordinator ownership, winner and accepted state before signing. */
export async function issueCoordinatedCallToken(
  config: CallRtcConfig,
  callId: string,
  role: "visitor" | "operator",
  now: number = Date.now(),
): Promise<{ url: string; token: string; expiresAt: number } | null> {
  if (!callRtcAvailable(config)) return null;
  return issueRoomToken(config, `krispy-${callId}`, callId, role, now);
}

async function issueRoomToken(
  config: CallRtcConfig,
  room: string,
  callId: string,
  role: "visitor" | "operator",
  now: number,
): Promise<{ url: string; token: string; expiresAt: number }> {
  const grant = await signClaims(
    config,
    `${role}-${callId}`,
    {
      roomJoin: true,
      room,
      canPublish: true,
      canPublishSources: ["microphone"],
      canPublishData: false,
      canSubscribe: true,
      canUpdateOwnMetadata: false,
    },
    now,
    CALL_TOKEN_TTL_SECONDS,
  );
  return { url: config.url!, ...grant };
}

/** DeleteRoom forcibly disconnects both participants. Retry on failure. */
export async function closeCallRoom(
  config: CallRtcConfig,
  room: string,
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
): Promise<boolean> {
  if (!callRtcAvailable(config)) return false;
  const grant = await signClaims(
    config,
    `server-${crypto.randomUUID()}`,
    { roomCreate: true },
    Date.now(),
    30,
  );
  const url = new URL(config.url!);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/twirp/livekit.RoomService/DeleteRoom";
  url.search = "";
  try {
    const response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
      body: JSON.stringify({ room }),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) return true;
    if (response.status === 404) {
      const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
      return body?.code === "not_found"; // room never acquired a participant
    }
    return false;
  } catch {
    return false;
  }
}

export type CallRoomObservation = "both_active" | "room_absent" | "not_both" | "unknown";

/** LiveKit's authenticated RoomService is the media-presence authority, never a client flag. */
export async function observeCallRoom(
  config: CallRtcConfig,
  callId: string,
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
): Promise<CallRoomObservation> {
  if (!callRtcAvailable(config)) return "unknown";
  const room = `krispy-${callId}`;
  const grant = await signClaims(
    config,
    `room-check-${crypto.randomUUID()}`,
    { roomAdmin: true, room },
    Date.now(),
    30,
  );
  const url = new URL(config.url!);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/twirp/livekit.RoomService/ListParticipants";
  url.search = "";
  try {
    const response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
      body: JSON.stringify({ room }),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) {
      const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
      return body?.code === "not_found" ? "room_absent" : "unknown";
    }
    if (!response.ok) return "unknown";
    const body = (await response.json().catch(() => null)) as {
      participants?: { identity?: unknown; state?: unknown }[];
    } | null;
    if (!Array.isArray(body?.participants)) return "unknown";
    const active = new Set(
      body.participants
        .filter((person) => person.state === 2 || person.state === "ACTIVE")
        .map((person) => person.identity),
    );
    return active.has(`operator-${callId}`) && active.has(`visitor-${callId}`)
      ? "both_active"
      : "not_both";
  } catch {
    return "unknown";
  }
}
