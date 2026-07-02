// Krispy Cloud billing routes (mounted at /api/billing by index.ts).
//
//   POST /checkout   → Creem hosted-checkout URL for the $19/mo (or annual) plan
//   POST /webhook    → verify Creem signature, update the subscription row (idempotent)
//   POST /portal     → Creem self-service billing portal URL
//   GET  /status     → the tenant's plan / status / entitlement / limits
//
// Built as a factory so `bun test` can inject a Mock provider + an in-memory repo
// + a spy for the edge snapshot push — no DB, no network, no Creem creds.
import { Hono } from "hono";
import { z } from "zod";
import {
  type BillingRepo,
  type EntitlementSnapshot,
  UNLIMITED,
  productIdFor,
  snapshotForRow,
  mapEvent,
} from "@krispy/billing";
import type { PaymentProvider } from "./provider.js";

/** Pushes the freshly-computed entitlement snapshot to the edge Worker's gate. */
export type SyncEntitlement = (tenantId: string, snap: EntitlementSnapshot) => Promise<void>;

export interface BillingDeps {
  provider: PaymentProvider;
  repo: BillingRepo;
  sync: SyncEntitlement;
  /** Env for product-id resolution (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

const CheckoutBody = z.object({
  tenantId: z.string().min(1),
  interval: z.enum(["monthly", "annual"]).default("monthly"),
  email: z.string().email().optional(),
  successUrl: z.string().url().optional(),
});

const PortalBody = z.object({ tenantId: z.string().min(1) });

export function createBillingApp(deps: BillingDeps): Hono {
  const { provider, repo, sync } = deps;
  const env = deps.env ?? process.env;
  const app = new Hono();

  // POST /checkout — start a paid subscription. requestId=tenantId so the webhook
  // can attribute the resulting subscription back to this tenant.
  app.post("/checkout", async (c) => {
    const parsed = CheckoutBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
    const { tenantId, interval, email, successUrl } = parsed.data;
    let productId: string;
    try {
      productId = productIdFor(interval, env);
    } catch {
      return c.json({ error: `The ${interval} plan is not configured` }, 409);
    }
    try {
      const session = await provider.createCheckout({
        productId,
        requestId: tenantId,
        successUrl,
        customerEmail: email,
      });
      return c.json(session, 201);
    } catch (err) {
      console.error("[billing] checkout error:", err);
      return c.json({ error: "Checkout failed" }, 502);
    }
  });

  // POST /webhook — RAW body first (signature is over exact bytes), verify, apply.
  app.post("/webhook", async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header("creem-signature") ?? null;
    const event = provider.verifyWebhook(rawBody, signature);
    if (!event) return c.json({ error: "Invalid signature" }, 401);

    const patch = mapEvent(event);
    if (!patch) return c.json({ received: true, ignored: true }); // ack & ignore

    const row = await repo.applyEvent(patch);
    if (!row) return c.json({ received: true, unattributed: true }); // no matching tenant

    // Push the recomputed entitlement to the edge gate (best-effort; never fails
    // the webhook — Creem would otherwise retry an already-applied event).
    try {
      await sync(row.tenantId, snapshotForRow(row));
    } catch (err) {
      console.error("[billing] entitlement sync failed:", err);
    }
    return c.json({ received: true });
  });

  // POST /portal — self-service management for a subscribed tenant.
  app.post("/portal", async (c) => {
    const parsed = PortalBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid body" }, 400);
    const row = await repo.getByTenant(parsed.data.tenantId);
    if (!row?.providerCustomerId) {
      return c.json({ error: "No billing account for this tenant yet" }, 409);
    }
    try {
      const { url } = await provider.createPortal(row.providerCustomerId);
      return c.json({ url });
    } catch (err) {
      console.error("[billing] portal error:", err);
      return c.json({ error: "Portal failed" }, 502);
    }
  });

  // GET /status?tenantId= — the billing view. No row → free / self-host (unmetered).
  app.get("/status", async (c) => {
    const tenantId = c.req.query("tenantId");
    if (!tenantId) return c.json({ error: "tenantId required" }, 400);
    const row = await repo.getByTenant(tenantId);
    if (!row) {
      return c.json({
        tenantId,
        plan: "free",
        status: "active",
        entitled: true,
        limits: UNLIMITED,
        trialEndsAt: null,
        currentPeriodEnd: null,
      });
    }
    return c.json({ tenantId, ...snapshotForRow(row) });
  });

  return app;
}
