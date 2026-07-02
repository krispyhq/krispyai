import { PAYMENT_URL } from "../../../lib/config";
import { sessionUser, tenantIdFor } from "../../../lib/session";

// POST /api/billing/checkout { interval? } → { url } (Creem hosted checkout).
// The success_url returns the customer to this app's billing page. Email + tenantId
// come from the session, so the checkout is always attributed to the authed user.
export async function POST(req: Request) {
  const user = await sessionUser(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body: { interval?: "monthly" | "annual" } = await req.json().catch(() => ({}));
  const origin = new URL(req.url).origin;
  const res = await fetch(`${PAYMENT_URL}/api/billing/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tenantId: tenantIdFor(user),
      interval: body.interval ?? "monthly",
      email: user.email,
      successUrl: `${origin}/billing?checkout=success`,
    }),
  }).catch(() => null);
  if (!res) return Response.json({ error: "billing service unreachable" }, { status: 502 });
  const data: { checkoutUrl?: string; url?: string; error?: string } = await res
    .json()
    .catch(() => ({}));
  // Normalize the provider's `checkoutUrl` to a plain `url` for the client redirect.
  return Response.json({ ...data, url: data.checkoutUrl ?? data.url }, { status: res.status });
}
