// Billing routes — money/security path. Mock provider + in-memory repo + a spy
// for the edge snapshot push. No DB, no network, no Creem creds. `bun test`
import { expect, test, describe } from "bun:test";
import * as crypto from "node:crypto";
import type { Subscription } from "@krispy/db";
import type { BillingRepo, EntitlementSnapshot } from "@krispy/billing";
import { createBillingApp, type SyncEntitlement } from "./billing.js";
import { CreemProvider, MockProvider } from "./provider.js";

const ENV = { CREEM_PRODUCT_ID_MONTHLY: "prod_m", CREEM_PRODUCT_ID_ANNUAL: "prod_a" };

function row(over: Partial<Subscription>): Subscription {
  return {
    id: "row_1",
    tenantId: "tenant_42",
    userId: "user_1",
    plan: "cloud",
    status: "trialing",
    trialEndsAt: new Date(Date.now() + 14 * 864e5),
    currentPeriodEnd: null,
    providerCustomerId: null,
    providerSubscriptionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

// In-memory BillingRepo mirroring the real applyEvent lookup + absolute-set logic.
function fakeRepo(seed: Subscription[] = []): BillingRepo {
  const rows = new Map(seed.map((r) => [r.tenantId, r]));
  return {
    async startTrial(userId, tenantId) {
      const existing = rows.get(tenantId);
      if (existing) return existing;
      const r = row({ tenantId, userId });
      rows.set(tenantId, r);
      return r;
    },
    async getByTenant(tenantId) {
      return rows.get(tenantId) ?? null;
    },
    async applyEvent(patch) {
      let r = patch.tenantId ? rows.get(patch.tenantId) : undefined;
      if (!r && patch.providerSubscriptionId) {
        r = [...rows.values()].find(
          (x) => x.providerSubscriptionId === patch.providerSubscriptionId,
        );
      }
      if (!r) return null;
      r.plan = "cloud";
      r.status = patch.status;
      r.providerSubscriptionId = patch.providerSubscriptionId ?? r.providerSubscriptionId;
      r.providerCustomerId = patch.providerCustomerId ?? r.providerCustomerId;
      r.currentPeriodEnd = patch.currentPeriodEnd ?? r.currentPeriodEnd;
      return r;
    },
  };
}

function spySync(): SyncEntitlement & { calls: Array<[string, EntitlementSnapshot]> } {
  const calls: Array<[string, EntitlementSnapshot]> = [];
  const fn = (async (tenantId, snap) => {
    calls.push([tenantId, snap]);
  }) as SyncEntitlement & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

describe("POST /checkout", () => {
  test("monthly checkout returns { id, checkoutUrl } carrying the monthly product", async () => {
    const app = createBillingApp({
      provider: new MockProvider(),
      repo: fakeRepo(),
      sync: spySync(),
      env: ENV,
    });
    const res = await app.request("/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant_42", email: "buyer@x.test" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; checkoutUrl: string };
    expect(body.id).toStartWith("mock_");
    expect(body.checkoutUrl).toContain("product=prod_m"); // default interval = monthly
  });

  test("annual interval selects the annual product", async () => {
    const app = createBillingApp({
      provider: new MockProvider(),
      repo: fakeRepo(),
      sync: spySync(),
      env: ENV,
    });
    const res = await app.request("/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "t", interval: "annual" }),
    });
    const body = (await res.json()) as { checkoutUrl: string };
    expect(body.checkoutUrl).toContain("product=prod_a");
  });

  test("annual with no product id configured → 409", async () => {
    const app = createBillingApp({
      provider: new MockProvider(),
      repo: fakeRepo(),
      sync: spySync(),
      env: { CREEM_PRODUCT_ID_MONTHLY: "prod_m" },
    });
    const res = await app.request("/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "t", interval: "annual" }),
    });
    expect(res.status).toBe(409);
  });

  test("missing tenantId → 400", async () => {
    const app = createBillingApp({
      provider: new MockProvider(),
      repo: fakeRepo(),
      sync: spySync(),
      env: ENV,
    });
    const res = await app.request("/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /webhook (Creem signature + idempotency)", () => {
  const secret = "whsec_test";
  const provider = new CreemProvider("creem_test_x", secret);
  const eventBody = JSON.stringify({
    id: "evt_1",
    eventType: "subscription.active",
    object: {
      id: "sub_1",
      request_id: "tenant_42",
      customer: { id: "cust_1" },
      current_period_end_date: "2026-08-03T00:00:00Z",
    },
  });
  const sign = (b: string) => crypto.createHmac("sha256", secret).update(b).digest("hex");

  test("valid signature → applies, activates the row, pushes the snapshot", async () => {
    const repo = fakeRepo([row({ status: "trialing" })]);
    const sync = spySync();
    const app = createBillingApp({ provider, repo, sync, env: ENV });

    const res = await app.request("/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "creem-signature": sign(eventBody) },
      body: eventBody,
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ received: true });

    const updated = await repo.getByTenant("tenant_42");
    expect(updated?.status).toBe("active");
    expect(updated?.providerSubscriptionId).toBe("sub_1");
    expect(updated?.providerCustomerId).toBe("cust_1");

    expect(sync.calls).toHaveLength(1);
    expect(sync.calls[0]![0]).toBe("tenant_42");
    expect(sync.calls[0]![1]).toMatchObject({ status: "active", entitled: true });
  });

  test("replaying the same event is idempotent (same end state)", async () => {
    const repo = fakeRepo([row({ status: "trialing" })]);
    const app = createBillingApp({ provider, repo, sync: spySync(), env: ENV });
    const headers = { "content-type": "application/json", "creem-signature": sign(eventBody) };

    await app.request("/webhook", { method: "POST", headers, body: eventBody });
    await app.request("/webhook", { method: "POST", headers, body: eventBody });
    const updated = await repo.getByTenant("tenant_42");
    expect(updated?.status).toBe("active"); // still active, not corrupted by the replay
  });

  test("bad signature → 401, nothing applied", async () => {
    const repo = fakeRepo([row({ status: "trialing" })]);
    const app = createBillingApp({ provider, repo, sync: spySync(), env: ENV });
    const res = await app.request("/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "creem-signature": "deadbeef" },
      body: eventBody,
    });
    expect(res.status).toBe(401);
    expect((await repo.getByTenant("tenant_42"))?.status).toBe("trialing"); // untouched
  });

  test("unknown tenant → acked as unattributed, no throw", async () => {
    const app = createBillingApp({ provider, repo: fakeRepo(), sync: spySync(), env: ENV });
    const res = await app.request("/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "creem-signature": sign(eventBody) },
      body: eventBody,
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ unattributed: true });
  });
});

describe("POST /portal", () => {
  test("subscribed tenant → portal url", async () => {
    const repo = fakeRepo([row({ providerCustomerId: "cust_1", status: "active" })]);
    const app = createBillingApp({ provider: new MockProvider(), repo, sync: spySync(), env: ENV });
    const res = await app.request("/portal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant_42" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toContain("customer=cust_1");
  });

  test("tenant with no billing account → 409", async () => {
    const repo = fakeRepo([row({ providerCustomerId: null })]);
    const app = createBillingApp({ provider: new MockProvider(), repo, sync: spySync(), env: ENV });
    const res = await app.request("/portal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant_42" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("GET /status (metering vs plan)", () => {
  test("no row → free / self-host, unmetered, entitled", async () => {
    const app = createBillingApp({
      provider: new MockProvider(),
      repo: fakeRepo(),
      sync: spySync(),
      env: ENV,
    });
    const res = await app.request("/status?tenantId=self");
    const body = (await res.json()) as {
      plan: string;
      entitled: boolean;
      limits: { aiPerMonth: number | null };
    };
    expect(body.plan).toBe("free");
    expect(body.entitled).toBe(true);
    // Infinity can't survive JSON → serialized as null, which the edge reads as "unmetered".
    expect(body.limits.aiPerMonth).toBeNull();
  });

  test("cloud trial row → cloud plan, capped limits, entitled", async () => {
    const repo = fakeRepo([row({ status: "trialing" })]);
    const app = createBillingApp({ provider: new MockProvider(), repo, sync: spySync(), env: ENV });
    const res = await app.request("/status?tenantId=tenant_42");
    const body = (await res.json()) as {
      plan: string;
      status: string;
      entitled: boolean;
      limits: { aiPerMonth: number };
    };
    expect(body.plan).toBe("cloud");
    expect(body.status).toBe("trialing");
    expect(body.entitled).toBe(true);
    expect(body.limits.aiPerMonth).toBeGreaterThan(0);
  });
});
