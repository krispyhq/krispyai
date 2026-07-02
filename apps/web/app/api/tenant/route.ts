import { EDGE_URL, TENANT_SYNC_SECRET } from "../../lib/config";
import { sessionUser, tenantIdFor } from "../../lib/session";

// Per-tenant config: the Telegram bot token + supergroup chat id, plus the bot's
// system prompt / knowledge base. These persist in the edge Worker's KV under
// `tenant:<tenantId>` as { botToken, chatId, systemPrompt?, model? } — the exact
// shape services/edge `getTenant()` reads (services/edge/src/store.ts).
//
// ── CONTRACT for the edge side (route does NOT exist yet — TODO, see report) ──
//   GET  {EDGE_URL}/api/tenant/config?t=<tenantId>
//        header  x-tenant-sync-secret: <shared secret>
//        → 200 { botToken, chatId, systemPrompt?, model? }  |  404 (no config yet)
//   POST {EDGE_URL}/api/tenant/config
//        header  x-tenant-sync-secret: <shared secret>
//        body    { tenantId, config: { botToken?, chatId?, systemPrompt?, model? } }
//        → merge into KV `tenant:<tenantId>`, 200 { ok: true }
//   Both must be guarded by the shared secret (they read/write a Telegram token) —
//   never reachable from the browser directly; this handler is the only caller.
//
// Until that edge route ships, GET returns { pending: true } and POST reports the
// gap honestly to the UI instead of silently dropping the config.

const secretHeader: Record<string, string> = TENANT_SYNC_SECRET
  ? { "x-tenant-sync-secret": TENANT_SYNC_SECRET }
  : {};

export async function GET(req: Request) {
  const user = await sessionUser(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const res = await fetch(
    `${EDGE_URL}/api/tenant/config?t=${encodeURIComponent(tenantIdFor(user))}`,
    { headers: secretHeader, cache: "no-store" },
  ).catch(() => null);

  if (!res) return Response.json({ pending: true, config: null });
  if (res.status === 404) return Response.json({ config: null });
  if (!res.ok) return Response.json({ pending: true, config: null });
  const config = await res.json().catch(() => null);
  return Response.json({ config });
}

export async function POST(req: Request) {
  const user = await sessionUser(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body: { botToken?: string; chatId?: string; systemPrompt?: string; model?: string } =
    await req.json().catch(() => ({}));

  const res = await fetch(`${EDGE_URL}/api/tenant/config`, {
    method: "POST",
    headers: { "content-type": "application/json", ...secretHeader },
    body: JSON.stringify({ tenantId: tenantIdFor(user), config: body }),
  }).catch(() => null);

  // Edge route not wired yet (unreachable or 404) → tell the UI honestly.
  if (!res || res.status === 404) {
    return Response.json(
      { ok: false, pending: true, error: "Tenant-config endpoint not wired on the edge yet." },
      { status: 202 },
    );
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return Response.json({ ok: false, error: err?.error ?? `HTTP ${res.status}` }, { status: 502 });
  }
  return Response.json({ ok: true });
}
