import { create } from "zustand";
import type { AuthSession, LoginStatus } from "@shared/types/auth";
import { AuthService } from "../services/auth/AuthService";

interface AuthState {
  session: AuthSession | null;
  loginStatus: LoginStatus;
  ready: boolean;
  /** Loads the current session and subscribes to main-process push updates. Safe to call
   *  from every Layout mount — only wires the subscription once. */
  init: () => void;
  login: () => Promise<void>;
  submitManualCode: (code: string) => Promise<void>;
  cancelLogin: () => Promise<void>;
  logout: () => Promise<void>;
}

let subscribed = false;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  loginStatus: { phase: "idle" },
  ready: false,

  init() {
    if (!subscribed) {
      subscribed = true;
      AuthService.onSessionChanged((session, loginStatus) => set({ session, loginStatus }));
    }
    AuthService.getSession()
      .then((session) => set({ session, ready: true }))
      .catch(() => set({ ready: true }));
  },

  async login() {
    try {
      await AuthService.login();
    } catch (err) {
      // Most failures are already broadcast by the main process (see doculigentAuth.ts);
      // this catch only matters for the synchronous "already in progress" rejection.
      set({ loginStatus: { phase: "error", message: errorMessage(err) } });
    }
  },

  async submitManualCode(code) {
    try {
      await AuthService.submitManualCode(code);
    } catch (err) {
      set({ loginStatus: { phase: "error", message: errorMessage(err) } });
    }
  },

  async cancelLogin() {
    await AuthService.cancelLogin();
  },

  async logout() {
    await AuthService.logout();
  },
}));
