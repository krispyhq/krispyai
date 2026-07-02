import { createAuthClient } from "better-auth/react";

// baseURL = the API origin. Better Auth appends its default basePath (/api/auth),
// so requests land on @krispy/api's /api/auth/* handler. Configurable, local default
// = the api service's standalone fallback port.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export const authClient = createAuthClient({
  baseURL: API_URL,
  // web and api are different origins → the session cookie is cross-origin.
  // `credentials: "include"` sends it; the API allows this origin with credentials
  // and lists it in Better Auth `trustedOrigins` (server-side contract).
  fetchOptions: { credentials: "include" },
});

export const { signIn, signUp, signOut, useSession } = authClient;
