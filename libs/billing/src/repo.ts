// DB-backed subscription store. The only place that touches Postgres; everything
// else in @krispy/billing is pure. Imports @krispy/db (a lib → lib import, allowed).
import { db, subscription, eq, type Subscription } from "@krispy/db";
import {
  trialEndsAt,
  toSnapshot,
  type SubStatus,
  type SubState,
  type EntitlementSnapshot,
} from "./entitlement";
import type { Plan } from "./plans";
import type { SubscriptionPatch } from "./webhook";

/** Narrow a stored row's `string` plan/status back to the pure-logic unions. */
export function rowToState(row: Subscription): SubState {
  return {
    plan: row.plan as Plan,
    status: row.status as SubStatus,
    trialEndsAt: row.trialEndsAt,
    currentPeriodEnd: row.currentPeriodEnd,
  };
}

/** The edge-gate snapshot for a DB row (pre-computes `entitled` + limits). */
export function snapshotForRow(row: Subscription, now: Date = new Date()): EntitlementSnapshot {
  return toSnapshot(rowToState(row), now);
}

/** The seam the payment router depends on — a fake stands in for `bun test`. */
export interface BillingRepo {
  startTrial(userId: string, tenantId: string): Promise<Subscription>;
  getByTenant(tenantId: string): Promise<Subscription | null>;
  applyEvent(patch: SubscriptionPatch): Promise<Subscription | null>;
}

/**
 * Grant the 14-day no-card Cloud trial. Idempotent: if a row already exists for
 * this tenant (e.g. a repeated signup hook), the existing row is returned
 * unchanged — we never restart someone's trial.
 */
async function startTrial(userId: string, tenantId: string): Promise<Subscription> {
  const inserted = await db
    .insert(subscription)
    .values({
      tenantId,
      userId,
      plan: "cloud",
      status: "trialing",
      trialEndsAt: trialEndsAt(),
    })
    .onConflictDoNothing({ target: subscription.tenantId })
    .returning();
  if (inserted[0]) return inserted[0];
  const existing = await getByTenant(tenantId);
  if (!existing) throw new Error(`startTrial: race with no row for tenant ${tenantId}`);
  return existing;
}

async function getByTenant(tenantId: string): Promise<Subscription | null> {
  const rows = await db.select().from(subscription).where(eq(subscription.tenantId, tenantId));
  return rows[0] ?? null;
}

/**
 * Apply a verified webhook patch to the owning row. Locates it by tenantId
 * (echoed via checkout request_id) and falls back to the provider subscription id
 * for lifecycle events that don't carry it. Sets ABSOLUTE state, so replaying the
 * same event is a no-op — webhooks are idempotent by construction. Returns the
 * updated row (for the entitlement snapshot push), or null if unattributable.
 */
async function applyEvent(patch: SubscriptionPatch): Promise<Subscription | null> {
  const row = patch.tenantId
    ? await getByTenant(patch.tenantId)
    : patch.providerSubscriptionId
      ? ((
          await db
            .select()
            .from(subscription)
            .where(eq(subscription.providerSubscriptionId, patch.providerSubscriptionId))
        )[0] ?? null)
      : null;
  if (!row) return null;

  const updated = await db
    .update(subscription)
    .set({
      plan: "cloud",
      status: patch.status,
      providerSubscriptionId: patch.providerSubscriptionId ?? row.providerSubscriptionId,
      providerCustomerId: patch.providerCustomerId ?? row.providerCustomerId,
      currentPeriodEnd: patch.currentPeriodEnd ?? row.currentPeriodEnd,
    })
    .where(eq(subscription.id, row.id))
    .returning();
  return updated[0] ?? null;
}

export const billingRepo: BillingRepo = { startTrial, getByTenant, applyEvent };
