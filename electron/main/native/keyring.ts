
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

function appAccountFor(integrationId: string): string {
  return `app-secret:${integrationId}`;
}

export function setAppSecret(integrationId: string, secret: string): Promise<void> {
  return keytar.setPassword(SERVICE, appAccountFor(integrationId), secret);
}

export function getAppSecret(integrationId: string): Promise<string | null> {
  return keytar.getPassword(SERVICE, appAccountFor(integrationId));
}

export async function deleteAppSecret(integrationId: string): Promise<void> {
  await keytar.deletePassword(SERVICE, appAccountFor(integrationId));
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

const S3_SECRET_ACCOUNT = "storage:s3SecretKey";

export function setS3SecretKey(secret: string): Promise<void> {
  return keytar.setPassword(SERVICE, S3_SECRET_ACCOUNT, secret);
}

export function getS3SecretKey(): Promise<string | null> {
  return keytar.getPassword(SERVICE, S3_SECRET_ACCOUNT);
}

export async function deleteS3SecretKey(): Promise<void> {
  await keytar.deletePassword(SERVICE, S3_SECRET_ACCOUNT);
}
