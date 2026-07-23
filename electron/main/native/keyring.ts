
import keytar from "keytar";

const SERVICE = "doculigent";

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

const AUTH_ACCOUNT = "auth:refreshToken";

export function setRefreshToken(token: string): Promise<void> {
  return keytar.setPassword(SERVICE, AUTH_ACCOUNT, token);
}

export function getRefreshToken(): Promise<string | null> {
  return keytar.getPassword(SERVICE, AUTH_ACCOUNT);
}

export async function clearRefreshToken(): Promise<void> {
  await keytar.deletePassword(SERVICE, AUTH_ACCOUNT);
}
