import type { AuthSession, LoginStatus } from "@shared/types/auth";

export const AuthService = {
  getSession(): Promise<AuthSession | null> {
    return window.api.auth.getSession();
  },
  login(): Promise<AuthSession> {
    return window.api.auth.login();
  },
  submitManualCode(code: string): Promise<void> {
    return window.api.auth.submitManualCode(code);
  },
  cancelLogin(): Promise<void> {
    return window.api.auth.cancelLogin();
  },
  logout(): Promise<void> {
    return window.api.auth.logout();
  },
  devLogin(): Promise<AuthSession> {
    return window.api.auth.devLogin();
  },
  onSessionChanged(callback: (session: AuthSession | null, status: LoginStatus) => void): () => void {
    return window.api.auth.onSessionChanged(callback);
  },
};
