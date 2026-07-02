import { PAYMENT_URL } from "../../../lib/config";
import { sessionUser, tenantIdFor } from "../../../lib/session";

// POST /api/billing/portal → { url } (Creem self-service portal: card, cancel, invoices).
// 409 from payment = no billing account yet (never subscribed) — surfaced to the UI.
export async function POST(req: Request) {
  const user = await sessionUser(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const res = await fetch(`${PAYMENT_URL}/api/billing/portal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenantId: tenantIdFor(user) }),
  }).catch(() => null);
  if (!res) return Response.json({ error: "billing service unreachable" }, { status: 502 });
  return Response.json(await res.json().catch(() => ({})), { status: res.status });
}
