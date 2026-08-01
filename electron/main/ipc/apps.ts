import { ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type { AppIntegration, AppIntegrationKind } from "@shared/types/models";
import * as store from "../native/settingsStore";
import { deleteAppSecret, getAppSecret, setAppSecret } from "../native/keyring";
import { commentOnGithubIssue, createGithubIssue, postSlackMessage, testAppConnection } from "../apps";

interface ActionResult {
  ok: boolean;
  message: string;
  url?: string;
}

// Every action handler resolves the integration's keychain secret by id and never throws
// over IPC — same {ok, message} contract as testConnection, so the Actions panel can
// render success/failure (and a link, for GitHub) inline without a try/catch of its own.
async function runAction(integrationId: string, action: (secret: string) => Promise<ActionResult>): Promise<ActionResult> {
  try {
    const secret = await getAppSecret(integrationId);
    if (!secret) throw new Error("This app isn't connected — reconnect it in Settings > Apps.");
    return await action(secret);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export function registerAppsIpc(): void {
  ipcMain.handle(Channels.apps.list, async (): Promise<AppIntegration[]> => store.listAppIntegrations());

  ipcMain.handle(
    Channels.apps.save,
    async (_event, integration: AppIntegration, secret?: string | null): Promise<void> => {
      if (secret) await setAppSecret(integration.id, secret);
      store.saveAppIntegration(integration);
    }
  );

  ipcMain.handle(Channels.apps.delete, async (_event, id: string): Promise<void> => {
    await deleteAppSecret(id);
    store.deleteAppIntegration(id);
  });

  // Mirrors ai.ts's testConnection contract exactly: never throws over IPC, always
  // resolves {ok, message} so the form can render success/failure inline. `secretOverride`
  // lets the form test with an unsaved, just-typed value before hitting Save, falling back
  // to the saved keychain secret (by integrationId) only when no override was given.
  ipcMain.handle(
    Channels.apps.testConnection,
    async (
      _event,
      kind: AppIntegrationKind,
      integrationId: string | null,
      secretOverride?: string | null
    ): Promise<{ ok: boolean; message: string }> => {
      try {
        const secret = secretOverride || (integrationId ? await getAppSecret(integrationId) : null);
        if (!secret) throw new Error("Enter a value to test.");
        await testAppConnection(kind, secret);
        return { ok: true, message: "Connected successfully." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  ipcMain.handle(
    Channels.apps.githubCreateIssue,
    async (_event, integrationId: string, repo: string, title: string, body: string): Promise<ActionResult> =>
      runAction(integrationId, async (secret) => {
        const issue = await createGithubIssue(secret, repo, title, body);
        return { ok: true, message: `Created issue #${issue.number}.`, url: issue.url };
      })
  );

  ipcMain.handle(
    Channels.apps.githubCommentIssue,
    async (
      _event,
      integrationId: string,
      repo: string,
      issueNumber: number,
      body: string
    ): Promise<ActionResult> =>
      runAction(integrationId, async (secret) => {
        const comment = await commentOnGithubIssue(secret, repo, issueNumber, body);
        return { ok: true, message: `Commented on #${comment.number}.`, url: comment.url };
      })
  );

  ipcMain.handle(
    Channels.apps.slackPostMessage,
    async (_event, integrationId: string, channel: string, text: string): Promise<ActionResult> =>
      runAction(integrationId, async (secret) => {
        await postSlackMessage(secret, channel, text);
        return { ok: true, message: `Posted to ${channel}.` };
      })
  );
}
