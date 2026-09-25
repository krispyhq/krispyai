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
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(config.apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
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
  const grant = await signClaims(
    config,
    `${role}-${call.id}`,
    {
      roomJoin: true,
      room: call.room,
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
