import type { AppIntegrationKind } from "@shared/types/models";

/** Read-only reachability/auth check: a personal access token can list the authenticated
 *  user without touching any repo, so this confirms the token is valid without needing
 *  any scope beyond the default. */
async function testGithub(secret: string): Promise<void> {
  const res = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${secret}`, "user-agent": "doculigent" },
  });
  if (!res.ok) throw new Error(`GitHub connection test failed: ${res.status} ${await res.text()}`);
}

/** Slack's auth.test endpoint just echoes back the token's identity — a read-only check,
 *  unlike posting to a channel, so testing never leaves a visible trace in the workspace. */
async function testSlack(secret: string): Promise<void> {
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (!res.ok || !body?.ok) throw new Error(`Slack connection test failed: ${body?.error ?? res.status}`);
}

/** Teams incoming webhooks have no read-only "who am I" equivalent — the only way to
 *  confirm one actually works is to post to it, so the test intentionally sends a small,
 *  clearly-labeled confirmation card (see the secret field's hint in the Settings UI). */
async function testTeams(secret: string): Promise<void> {
  const res = await fetch(secret, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      "@type": "MessageCard",
      "@context": "http://schema.org/extensions",
      summary: "Doculigent connection test",
      text: "✅ Doculigent successfully connected to this channel.",
    }),
  });
  if (!res.ok) throw new Error(`Microsoft Teams connection test failed: ${res.status} ${await res.text()}`);
}

export async function testAppConnection(kind: AppIntegrationKind, secret: string): Promise<void> {
  if (kind === "github") return testGithub(secret);
  if (kind === "slack") return testSlack(secret);
  return testTeams(secret);
}
