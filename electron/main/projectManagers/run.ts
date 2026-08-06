
import type { PmActionOutcome, PmRunResult, ProjectManager } from "@shared/types/projectManager";
import { resolvePmPersona } from "./insights";
import { getAppSecret } from "../native/keyring";
import { createGithubIssue, postSlackMessage } from "../apps";

const SLACK_TEXT_LIMIT = 3000;

function reportBody(pm: ProjectManager): string {
  const persona = resolvePmPersona(pm);
  if (pm.insights.length === 0) {
    return `No insights generated yet for ${pm.teamName}. Open ${pm.name} and transcribe/generate insights first.`;
  }
  const sections = pm.insights.map((i) => `## ${i.fileName}\n\n${i.detailed}`).join("\n\n");
  return `# ${pm.name} — ${persona.name} report for ${pm.teamName}\n\n${sections}`;
}

async function runOne(kind: PmActionOutcome["kind"], fn: () => Promise<PmActionOutcome>): Promise<PmActionOutcome> {
  try {
    return await fn();
  } catch (err) {
    return { kind, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function runProjectManager(pm: ProjectManager): Promise<PmRunResult> {
  const body = reportBody(pm);
  const actionResults: PmActionOutcome[] = [];

  const gh = pm.actions.githubCreateIssue;
  if (gh?.enabled) {
    actionResults.push(
      await runOne("githubCreateIssue", async () => {
        const secret = await getAppSecret(gh.integrationId);
        if (!secret) throw new Error("GitHub isn't connected — reconnect it in Settings > Apps.");
        const issue = await createGithubIssue(secret, gh.repo, `${pm.name} report — ${new Date().toLocaleDateString()}`, body);
        return { kind: "githubCreateIssue", ok: true, message: `Created issue #${issue.number}.`, url: issue.url };
      })
    );
  }

  const slack = pm.actions.slackPostMessage;
  if (slack?.enabled) {
    actionResults.push(
      await runOne("slackPostMessage", async () => {
        const secret = await getAppSecret(slack.integrationId);
        if (!secret) throw new Error("Slack isn't connected — reconnect it in Settings > Apps.");
        await postSlackMessage(secret, slack.channel, body.length > SLACK_TEXT_LIMIT ? `${body.slice(0, SLACK_TEXT_LIMIT)}…` : body);
        return { kind: "slackPostMessage", ok: true, message: `Posted to ${slack.channel}.` };
      })
    );
  }

  if (actionResults.length === 0) {
    return { ok: false, message: "No actions are enabled for this Project Manager.", actionResults };
  }
  const ok = actionResults.every((r) => r.ok);
  return { ok, message: ok ? "Run completed." : "Run completed with errors.", actionResults };
}
