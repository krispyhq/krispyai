// Pure Creem-webhook → subscription-patch mapper. No DB, no signature check (that
// happens in the provider adapter before we get here). Given a verified, normalized
// event, work out: which subscription does this touch, and what should its row
// become? Returns null for events we don't act on (so the caller acks & ignores).
//
// Creem event types (docs.creem.io): checkout.completed, subscription.active,
// subscription.paid, subscription.update, subscription.trialing,
// subscription.past_due, subscription.canceled, subscription.scheduled_cancel,
// subscription.expired, subscription.paused, refund.created, dispute.created.
import type { SubStatus } from "./entitlement";

/** Structurally compatible with services/payment's `WebhookEvent`. */
export interface ProviderEvent {
  eventType: string;
  object: Record<string, unknown>;
}

/** How to locate the row + what to set. Absolute state → idempotent to apply. */
export interface SubscriptionPatch {
  /** Preferred key: our tenant id, echoed via checkout `request_id` / metadata. */
  tenantId?: string;
  /** Fallback key for lifecycle events that don't carry our request_id. */
  providerSubscriptionId?: string;
  providerCustomerId?: string;
  status: SubStatus;
  currentPeriodEnd?: Date;
}

// Creem status verbs collapse onto our four stored statuses.
const STATUS_BY_EVENT: Record<string, SubStatus> = {
  "checkout.completed": "active",
  "subscription.active": "active",
  "subscription.paid": "active",
  "subscription.update": "active",
  "subscription.trialing": "trialing",
  "subscription.past_due": "past_due",
  "subscription.canceled": "canceled",
  "subscription.scheduled_cancel": "canceled",
  "subscription.expired": "canceled",
  "subscription.paused": "canceled",
  // A refund/chargeback pulls entitlement immediately.
  "refund.created": "canceled",
  "dispute.created": "canceled",
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

// Creem nests things a few ways depending on the event; dig tolerantly. The exact
// field casing is per Creem's webhook samples — confirm against your dashboard
// before go-live (see README go-live checklist). These paths are the documented
// ones plus defensive fallbacks.
function pickTenantId(obj: Record<string, unknown>): string | undefined {
  const meta = obj.metadata as Record<string, unknown> | undefined;
  return str(obj.request_id) ?? str(meta?.request_id) ?? str(meta?.tenantId);
}

function pickSubscriptionId(obj: Record<string, unknown>): string | undefined {
  // subscription.* events: the object IS the subscription (id = sub_…).
  // checkout.completed: the subscription hangs off `subscription`.
  const sub = obj.subscription;
  if (typeof sub === "string") return sub || undefined;
  if (sub && typeof sub === "object") {
    const id = str((sub as Record<string, unknown>).id);
    if (id) return id;
  }
  const id = str(obj.id);
  return id?.startsWith("sub_") ? id : undefined;
}

function pickCustomerId(obj: Record<string, unknown>): string | undefined {
  const c = obj.customer;
  if (typeof c === "string") return c || undefined;
  if (c && typeof c === "object") return str((c as Record<string, unknown>).id);
  return undefined;
}

function pickPeriodEnd(obj: Record<string, unknown>): Date | undefined {
  const raw =
    str(obj.current_period_end_date) ??
    str(obj.current_period_end) ??
    str((obj.subscription as Record<string, unknown> | undefined)?.current_period_end_date);
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function mapEvent(event: ProviderEvent): SubscriptionPatch | null {
  const status = STATUS_BY_EVENT[event.eventType];
  if (!status) return null; // unhandled event → ack & ignore
  const obj = event.object ?? {};
  const patch: SubscriptionPatch = {
    status,
    tenantId: pickTenantId(obj),
    providerSubscriptionId: pickSubscriptionId(obj),
    providerCustomerId: pickCustomerId(obj),
    currentPeriodEnd: pickPeriodEnd(obj),
  };
  // Nothing to attribute the event to → can't act.
  if (!patch.tenantId && !patch.providerSubscriptionId) return null;
  return patch;
}
