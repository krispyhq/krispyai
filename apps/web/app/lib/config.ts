// Env-driven origins. The dashboard never talks to the backend services directly
// from the browser — it goes through this app's own /api/* route handlers (same
// origin, no CORS, secrets stay server-side). So these are read on the server only.
//
// Local defaults are the services' own standalone fallback ports (see each service's
// index.ts): api → 3001, payment → 3002, edge (wrangler dev) → 8787. In Tilt/prod
// these are set to the portless URLs. Never hardcode a production host in a page.

/** Better Auth API (services/api). Session lives here. */
export const API_URL =
  process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** Krispy Cloud billing (services/payment) — /api/billing/{status,checkout,portal}. */
export const PAYMENT_URL = process.env.PAYMENT_URL ?? "http://localhost:3002";

/** The live-chat edge Worker (services/edge) — /api/usage, tenant config. */
export const EDGE_URL = process.env.EDGE_URL ?? "http://localhost:8787";

/** Guards the edge tenant-config write (must match the edge Worker's binding).
 *  Reuses the same shared-secret pattern as BILLING_SYNC_SECRET. */
export const TENANT_SYNC_SECRET = process.env.TENANT_SYNC_SECRET ?? process.env.BILLING_SYNC_SECRET;

/** Browser-visible edge origin — only used to render the copy-paste widget snippet
 *  and its src. Public by design (it's the same origin the widget POSTs to). */
export const PUBLIC_EDGE_URL = process.env.NEXT_PUBLIC_EDGE_URL ?? "http://localhost:8787";
