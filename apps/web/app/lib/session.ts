import { API_URL } from "./config";

export interface SessionUser {
  id: string;
  email?: string;
  name?: string;
}

/**
 * Server-side session resolution for route handlers. Forwards the incoming auth
 * cookie to Better Auth's get-session endpoint on services/api and returns the
 * user, or null when unauthenticated.
 *
 * The tenantId is ALWAYS the authed user's id (derived here, never trusted from the
 * client body) — so a user can only ever read/write their OWN tenant. This is the
 * security boundary for every proxied billing / usage / tenant-config call.
 */
export async function sessionUser(req: Request): Promise<SessionUser | null> {
  const res = await fetch(`${API_URL}/api/auth/get-session`, {
    headers: { cookie: req.headers.get("cookie") ?? "" },
    cache: "no-store",
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data: { user?: SessionUser } | null = await res.json().catch(() => null);
  if (!data?.user?.id) return null;
  return { id: data.user.id, email: data.user.email, name: data.user.name };
}

/** The tenant id for a user. Cloud is one tenant per account → the user's id. */
export function tenantIdFor(user: SessionUser): string {
  return user.id;
}
