import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

// One subscription row per tenant — the billing state for Krispy Cloud.
// Self-host (tenantId "self") never gets a row: it's free-forever and always
// entitled, so the absence of a row IS the "self-host / free" signal.
//
// The row is the source of truth the webhook writes and the entitlement gate
// reads. Statuses are absolute (the webhook SETS them from the provider event),
// which makes webhook handling idempotent by construction — applying
// `subscription.active` twice lands on the same row.
export const subscription = pgTable(
  "subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The tenant seam (services/edge keys everything by tenantId). Unique: one
    // billing state per tenant.
    tenantId: text("tenant_id").notNull().unique(),
    // The Better Auth user who owns this subscription.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // 'free' = self-host / unmetered; 'cloud' = the paid $19/mo (or annual) plan.
    plan: text("plan").notNull().default("free"),
    // 'trialing' | 'active' | 'past_due' | 'canceled'. (Creem also emits
    // 'expired'/'paused'/'scheduled_cancel' — mapped down to these four.)
    status: text("status").notNull().default("trialing"),
    // App-owned 14-day no-card trial (set on Cloud signup, not by the provider).
    trialEndsAt: timestamp("trial_ends_at"),
    // Paid period end, from the provider's `current_period_end_date`.
    currentPeriodEnd: timestamp("current_period_end"),
    // Creem customer + subscription ids (for the portal + reconciliation).
    providerCustomerId: text("provider_customer_id"),
    providerSubscriptionId: text("provider_subscription_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("subscription_user_id_idx").on(table.userId),
    index("subscription_provider_subscription_id_idx").on(table.providerSubscriptionId),
  ],
);

export const subscriptionRelations = relations(subscription, ({ one }) => ({
  user: one(user, { fields: [subscription.userId], references: [user.id] }),
}));

export type Subscription = typeof subscription.$inferSelect;
export type NewSubscription = typeof subscription.$inferInsert;
