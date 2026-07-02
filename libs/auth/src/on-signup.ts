import { PostHog } from "posthog-node";
import { sendEmail } from "@krispy/email";
import { billingRepo, snapshotForRow, pushEntitlement } from "@krispy/billing";
// Server-safe event catalog — same names/types the client's `track` uses. Import from
// the /events subpath (no browser SDK) so this server module stays import-safe.
import { serverEvent, securityEvent } from "@krispy/analytics/events";

const KEY = process.env.POSTHOG_API_KEY;
const HOST = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";

// ponytail: dedicated server-side PostHog client for the signup hook. It mirrors
// services/api/src/analytics.ts (same 6 lines) because a lib can't import a
// service. Extract a @krispy/analytics lib if a third consumer shows up.
let ph: PostHog | null | undefined;
function posthog(): PostHog | null {
  if (ph === undefined) ph = KEY ? new PostHog(KEY, { host: HOST }) : null;
  return ph;
}

/**
 * Runs after Better Auth creates a user (see `databaseHooks.user.create.after`).
 * This is the concrete event -> email seed for the PostHog-driven drip (docs/email.md):
 *   (a) capture a `user_signed_up` PostHog event — the drip campaign's trigger
 *   (b) send the coded welcome email (day-0) via @krispy/email
 * ENV-GATED: no keys -> both calls no-op, sign-up still succeeds.
 */
export async function onUserSignedUp(user: {
  id: string;
  email: string;
  name?: string | null;
}): Promise<void> {
  const name = user.name?.trim() || user.email.split("@")[0] || "there";

  // (a) analytics event — server-side, attributed to the new user's id. The name +
  // payload are checked against the shared catalog (@krispy/analytics/events).
  posthog()?.capture({
    distinctId: user.id,
    ...serverEvent("user_signed_up", { email: user.email }),
  });

  // (b) welcome email — never let a mail failure break sign-up
  try {
    await sendEmail({ to: user.email, template: "welcome", props: { name } });
  } catch (err) {
    console.error("[auth] welcome email failed", err);
  }

  // (c) start the 14-day no-card Krispy Cloud trial. Every Better Auth signup is a
  // Cloud signup (self-host has no accounts), so the tenant seam is the user id.
  // Best-effort: a billing hiccup must never break sign-up. Idempotent in the repo.
  try {
    const sub = await billingRepo.startTrial(user.id, user.id);
    // Push the trial snapshot to the edge gate so the trial is entitled immediately
    // (env-gated no-op if the Worker sync isn't configured).
    await pushEntitlement(sub.tenantId, snapshotForRow(sub));
  } catch (err) {
    console.error("[auth] trial start failed", err);
  }
}

/**
 * SOC2 audit trail for a successful sign-in (wired to `session.create.after`).
 * `securityEvent()` ALWAYS writes the structured stdout audit line; PostHog capture is
 * best-effort (no key → no-op). Call securityEvent() first so the audit line is written
 * even when PostHog is absent (optional-chaining would skip arg evaluation otherwise).
 */
export function logSignIn(userId: string): void {
  const payload = securityEvent(userId, "auth_signed_in", {});
  posthog()?.capture(payload);
}
