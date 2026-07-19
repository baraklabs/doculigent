/**
 * Thin OS-keychain wrapper (keytar) for LLM provider API keys — mirrors
 * FUNCTIONALITY.md §10/§15's BYOK-into-OS-keyring behavior. Service name "doculigent"
 * (this is a fresh app identity for the Electron rewrite, not required to match the old
 * Tauri app's "com.doculigent.app" keyring entries).
 */
import keytar from "keytar";

const SERVICE = "doculigent";

// Keyed by model *profile* id (not provider kind) — two saved profiles of the same kind
// (e.g. two OpenRouter models) can hold different keys.
function llmAccountFor(profileId: string): string {
  return `llm-key:${profileId}`;
}

export function setLlmApiKey(profileId: string, key: string): Promise<void> {
  return keytar.setPassword(SERVICE, llmAccountFor(profileId), key);
}

export function getLlmApiKey(profileId: string): Promise<string | null> {
  return keytar.getPassword(SERVICE, llmAccountFor(profileId));
}

export async function deleteLlmApiKey(profileId: string): Promise<void> {
  await keytar.deletePassword(SERVICE, llmAccountFor(profileId));
}

const AUTH_ACCOUNT = "auth:session";

export interface StoredAuthTokens {
  accessToken: string;
  refreshToken: string | null;
}

/** doculigent.com OAuth tokens — kept in the OS keychain like LLM provider keys above,
 *  never in the plaintext settings.json (see settingsStore.ts for the non-secret profile). */
export function setAuthTokens(tokens: StoredAuthTokens): Promise<void> {
  return keytar.setPassword(SERVICE, AUTH_ACCOUNT, JSON.stringify(tokens));
}

export async function getAuthTokens(): Promise<StoredAuthTokens | null> {
  const raw = await keytar.getPassword(SERVICE, AUTH_ACCOUNT);
  return raw ? (JSON.parse(raw) as StoredAuthTokens) : null;
}

export async function clearAuthTokens(): Promise<void> {
  await keytar.deletePassword(SERVICE, AUTH_ACCOUNT);
}
