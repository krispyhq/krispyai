import { EDGE_URL } from "../../lib/config";
import { sessionUser, tenantIdFor } from "../../lib/session";

// GET /api/usage → this month's AI answers + handoffs vs the plan caps.
// Proxies the edge Worker GET /api/usage?t=<tenant>.
export async function GET(req: Request) {
  const user = await sessionUser(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const res = await fetch(`${EDGE_URL}/api/usage?t=${encodeURIComponent(tenantIdFor(user))}`, {
    cache: "no-store",
  }).catch(() => null);
  if (!res) return Response.json({ error: "edge service unreachable" }, { status: 502 });
  return Response.json(await res.json().catch(() => ({})), { status: res.status });
}
