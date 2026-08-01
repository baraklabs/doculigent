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

export async function testAppConnection(kind: AppIntegrationKind, secret: string): Promise<void> {
  if (kind === "github") return testGithub(secret);
  return testSlack(secret);
}

export interface GithubIssueResult {
  url: string;
  number: number;
}

// `repo` is "owner/repo" (as typed in the Actions panel) rather than separate owner/name
// fields — matches how everyone actually writes/copies a repo slug, and GitHub's own API
// path takes it in exactly that shape.
export async function createGithubIssue(secret: string, repo: string, title: string, body: string): Promise<GithubIssueResult> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "user-agent": "doculigent", "content-type": "application/json" },
    body: JSON.stringify({ title, body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub create issue failed: ${res.status} ${text}`);
  const json = JSON.parse(text) as { html_url: string; number: number };
  return { url: json.html_url, number: json.number };
}

export async function commentOnGithubIssue(
  secret: string,
  repo: string,
  issueNumber: number,
  body: string
): Promise<GithubIssueResult> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "user-agent": "doculigent", "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub comment failed: ${res.status} ${text}`);
  const json = JSON.parse(text) as { html_url: string };
  return { url: json.html_url, number: issueNumber };
}

// Uses the same bot token as testSlack — chat.postMessage needs the channel the bot is
// actually in (or a public channel), typed by the user each time rather than stored on the
// integration (see AppIntegration's comment: no per-kind fields beyond the secret today).
export async function postSlackMessage(secret: string, channel: string, text: string): Promise<void> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ channel, text }),
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (!res.ok || !body?.ok) throw new Error(`Slack post message failed: ${body?.error ?? res.status}`);
}

