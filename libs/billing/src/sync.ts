// Push an entitlement snapshot to the edge Worker's gate. This is how a billing
// change (trial start, subscribe, cancel, payment failure) reaches the edge —
// the source-of-truth DB lives here (Postgres), the gate lives in workerd (KV),
// so we PUSH the pre-computed snapshot over one guarded HTTP call. No polling.
//
// Best-effort + env-gated: no EDGE_ENTITLEMENT_URL / BILLING_SYNC_SECRET (e.g.
// self-host, or the Worker isn't reachable from this process) → silent no-op.
// Callers (auth signup, payment webhook) wrap it in try/catch anyway — a sync
// hiccup must never break sign-up or ack of a webhook.
import type { EntitlementSnapshot } from "./entitlement";

export async function pushEntitlement(
  tenantId: string,
  snapshot: EntitlementSnapshot,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const url = env.EDGE_ENTITLEMENT_URL;
  const secret = env.BILLING_SYNC_SECRET;
  if (!url || !secret) return;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-billing-sync-secret": secret },
    body: JSON.stringify({ tenantId, snapshot }),
  });
}
