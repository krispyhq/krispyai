// Pure billing logic — trial math, entitlement across states, snapshot, and the
// Creem webhook → patch mapping. No DB, no network. `bun test`
import { expect, test, describe } from "bun:test";
import { TRIAL_DAYS, limitsFor, productIdFor, CLOUD_LIMITS, UNLIMITED } from "./plans";
import { entitled, trialEndsAt, withinLimits, toSnapshot, type SubState } from "./entitlement";
import { mapEvent } from "./webhook";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-07-03T00:00:00Z");

describe("trial", () => {
  test("trialEndsAt is 14 days out", () => {
    expect(trialEndsAt(now).getTime() - now.getTime()).toBe(TRIAL_DAYS * DAY);
  });

  test("fresh Cloud trial is entitled; expired trial is gated", () => {
    const sub: SubState = { plan: "cloud", status: "trialing", trialEndsAt: trialEndsAt(now) };
    expect(entitled(sub, now)).toBe(true);
    const later = new Date(now.getTime() + 15 * DAY);
    expect(entitled(sub, later)).toBe(false); // trial expired → flips to gated, no cron
  });

  test("trialing with no deadline fails closed", () => {
    expect(entitled({ plan: "cloud", status: "trialing", trialEndsAt: null }, now)).toBe(false);
  });
});

describe("entitlement across states", () => {
  test("self-host / free is always entitled", () => {
    expect(entitled({ plan: "free", status: "canceled" }, now)).toBe(true);
  });
  test("active is entitled", () => {
    expect(entitled({ plan: "cloud", status: "active" }, now)).toBe(true);
  });
  test("past_due keeps a grace until period end", () => {
    const end = new Date(now.getTime() + 3 * DAY);
    expect(entitled({ plan: "cloud", status: "past_due", currentPeriodEnd: end }, now)).toBe(true);
    const after = new Date(now.getTime() + 4 * DAY);
    expect(entitled({ plan: "cloud", status: "past_due", currentPeriodEnd: end }, after)).toBe(
      false,
    );
  });
  test("canceled keeps access through the paid-for period", () => {
    const end = new Date(now.getTime() + 10 * DAY);
    expect(entitled({ plan: "cloud", status: "canceled", currentPeriodEnd: end }, now)).toBe(true);
    expect(entitled({ plan: "cloud", status: "canceled", currentPeriodEnd: null }, now)).toBe(
      false,
    );
  });
});

describe("metering vs plan", () => {
  test("self-host is unmetered", () => {
    expect(limitsFor("free")).toEqual(UNLIMITED);
    expect(withinLimits({ ai: 1e9, handoff: 1e9 }, UNLIMITED)).toBe(true);
  });
  test("Cloud caps AI usage, handoffs unmetered", () => {
    expect(withinLimits({ ai: CLOUD_LIMITS.aiPerMonth - 1, handoff: 1e9 }, CLOUD_LIMITS)).toBe(
      true,
    );
    expect(withinLimits({ ai: CLOUD_LIMITS.aiPerMonth, handoff: 0 }, CLOUD_LIMITS)).toBe(false);
  });
});

describe("productIdFor", () => {
  const env = { CREEM_PRODUCT_ID_MONTHLY: "prod_m", CREEM_PRODUCT_ID_ANNUAL: "prod_a" };
  test("resolves monthly + annual", () => {
    expect(productIdFor("monthly", env)).toBe("prod_m");
    expect(productIdFor("annual", env)).toBe("prod_a");
  });
  test("throws when the interval isn't configured", () => {
    expect(() => productIdFor("annual", { CREEM_PRODUCT_ID_MONTHLY: "prod_m" })).toThrow();
  });
});

describe("toSnapshot", () => {
  test("packs the pre-computed entitled flag + limits for the edge gate", () => {
    const snap = toSnapshot(
      { plan: "cloud", status: "trialing", trialEndsAt: trialEndsAt(now) },
      now,
    );
    expect(snap).toMatchObject({ plan: "cloud", status: "trialing", entitled: true });
    expect(snap.limits).toEqual(CLOUD_LIMITS);
    expect(typeof snap.trialEndsAt).toBe("string");
  });
});

describe("mapEvent (Creem → patch)", () => {
  test("subscription.active → active, keyed by request_id (tenantId)", () => {
    const patch = mapEvent({
      eventType: "subscription.active",
      object: {
        id: "sub_1",
        request_id: "tenant_42",
        customer: { id: "cust_1" },
        current_period_end_date: "2026-08-03T00:00:00Z",
      },
    });
    expect(patch).toMatchObject({
      status: "active",
      tenantId: "tenant_42",
      providerSubscriptionId: "sub_1",
      providerCustomerId: "cust_1",
    });
    expect(patch?.currentPeriodEnd?.toISOString()).toBe("2026-08-03T00:00:00.000Z");
  });

  test("checkout.completed digs the subscription id out of nested object", () => {
    const patch = mapEvent({
      eventType: "checkout.completed",
      object: {
        id: "ch_1",
        subscription: { id: "sub_9" },
        customer: "cust_9",
        metadata: { tenantId: "tenant_9" },
      },
    });
    expect(patch).toMatchObject({
      status: "active",
      tenantId: "tenant_9",
      providerSubscriptionId: "sub_9",
      providerCustomerId: "cust_9",
    });
  });

  test("cancel/refund/dispute all revoke", () => {
    for (const e of ["subscription.canceled", "subscription.expired", "refund.created"]) {
      expect(mapEvent({ eventType: e, object: { id: "sub_1" } })?.status).toBe("canceled");
    }
  });

  test("unhandled event → null (ack & ignore)", () => {
    expect(mapEvent({ eventType: "ping", object: {} })).toBeNull();
  });

  test("unattributable event (no tenant, no sub id) → null", () => {
    expect(mapEvent({ eventType: "subscription.active", object: {} })).toBeNull();
  });
});
