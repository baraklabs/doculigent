
export interface AuthPlan {
  tier: string; 
  interval: string; 
  startedAt: string | null; 
  priceUsd: number | null;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  plan: AuthPlan | null;
}

export interface AuthSession {
  user: AuthUser;
  expiresAt: string | null; 
}

export type LoginStatus =
  | { phase: "idle" }
  | { phase: "awaitingCallback" }
  | { phase: "exchangingCode" }
  | { phase: "error"; message: string };
