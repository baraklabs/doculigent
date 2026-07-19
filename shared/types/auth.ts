/**
 * doculigent.com account types — the cloud counterpart of the local-first app (see
 * providers/auth/AuthProvider.ts history: previously a Phase 2 stub, now wired to a real
 * OAuth 2.0 Authorization Code + PKCE flow against doculigent.com).
 */

export interface AuthUser {
  id: string;
  name: string;
  email: string;
}

export interface AuthSession {
  user: AuthUser;
  expiresAt: string | null; // ISO 8601; null if the token doesn't expire / expiry unknown
}

/**
 * State of an in-flight login attempt, pushed to the renderer so the Account page can
 * render the right step without polling. "awaitingCallback" covers both paths at once:
 * the loopback server is listening for the automatic browser redirect *and* the user can
 * paste the code doculigent.com shows on-page if that redirect never arrives.
 */
export type LoginStatus =
  | { phase: "idle" }
  | { phase: "awaitingCallback" }
  | { phase: "exchangingCode" }
  | { phase: "error"; message: string };
