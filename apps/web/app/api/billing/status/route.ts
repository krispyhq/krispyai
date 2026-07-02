import { PAYMENT_URL } from "../../../lib/config";
import { sessionUser, tenantIdFor } from "../../../lib/session";

// GET /api/billing/status → the authed tenant's plan / status / trial / limits.
// Proxies services/payment GET /api/billing/status?tenantId=. tenantId is the
// authed user's id (never from the client), so you only see your own billing.
export async function GET(req: Request) {
  const user = await sessionUser(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const res = await fetch(
    `${PAYMENT_URL}/api/billing/status?tenantId=${encodeURIComponent(tenantIdFor(user))}`,
    { cache: "no-store" },
  ).catch(() => null);
  if (!res) return Response.json({ error: "billing service unreachable" }, { status: 502 });
  return Response.json(await res.json().catch(() => ({})), { status: res.status });
}
