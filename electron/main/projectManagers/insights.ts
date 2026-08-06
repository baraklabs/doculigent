
import type { LlmModelProfile } from "@shared/types/models";
import type { PmFileInsight, PmOverallInsight, ProjectManager } from "@shared/types/projectManager";
import { DEFAULT_DETAILED_PROMPT, DEFAULT_QUICK_PROMPT, resolvePersonaById } from "@shared/constants/pmPersonas";
import * as libraryStore from "../native/libraryStore";
import { getLlmProfile, listCustomPersonas, listLlmProfiles } from "../native/settingsStore";
import { getLlmApiKey } from "../native/keyring";
import * as aiRouter from "../ai";
import { transcriptToPlainText } from "./transcriptText";

export function resolveChatProfile(pm: ProjectManager, profileId: string | undefined): LlmModelProfile {
  const wanted = profileId ?? pm.chatProfileId ?? undefined;
  const profile = wanted ? getLlmProfile(wanted) : (listLlmProfiles().find((p) => p.capabilities.includes("chat")) ?? null);
  if (!profile) throw new Error("No AI model is configured — add one in Settings.");
  return profile;
}
export function resolvePmPersona(pm: ProjectManager): ReturnType<typeof resolvePersonaById> {
  return resolvePersonaById(pm.persona, listCustomPersonas());
}

const MAX_CONTEXT_CHARS_PER_FILE = 6000;

function insightSystemPrompt(persona: ReturnType<typeof resolvePersonaById>, fileName: string, transcriptText: string): string {
  const extra = persona.filePrompt?.trim() ? ` ${persona.filePrompt.trim()}` : "";
  return (
    `You are acting as a ${persona.name} reviewing a recording titled "${fileName}". ` +
    `Focus specifically on ${persona.focus}.${extra} Base your answer only on the transcript below.\n\n${transcriptText}`
  );
}

export async function generateFileInsight(
  pm: ProjectManager,
  fileId: string,
  fileName: string,
  profileId?: string
): Promise<PmFileInsight> {
  const video = libraryStore.getVideoBySyncedTeamFileId(fileId);
  if (!video?.transcript) {
    throw new Error(`"${fileName}" hasn't been transcribed yet — transcribe it first.`);
  }

  const profile = resolveChatProfile(pm, profileId);
  const apiKey = profile.needsKey ? await getLlmApiKey(profile.id) : null;
  const persona = resolvePmPersona(pm);
  const system = insightSystemPrompt(persona, fileName, transcriptToPlainText(video.transcript));

  const quick = await aiRouter.chat(null, [], DEFAULT_QUICK_PROMPT, profile, apiKey, system);
  const detailed = await aiRouter.chat(null, [], DEFAULT_DETAILED_PROMPT, profile, apiKey, system);

  return { fileId, fileName, quick: quick.content, detailed: detailed.content, generatedAt: new Date().toISOString() };
}

export async function generateOverallInsight(pm: ProjectManager, profileId?: string): Promise<PmOverallInsight> {
  if (pm.insights.length === 0) {
    throw new Error("Generate at least one file insight first.");
  }

  const profile = resolveChatProfile(pm, profileId);
  const apiKey = profile.needsKey ? await getLlmApiKey(profile.id) : null;
  const persona = resolvePmPersona(pm);
  const sections = pm.insights.map((i) => `### ${i.fileName}\n${i.detailed.slice(0, MAX_CONTEXT_CHARS_PER_FILE)}`).join("\n\n");
  const summaryExtra = persona.summaryPrompt?.trim() ? ` ${persona.summaryPrompt.trim()}` : "";
  const system =
    `You are acting as a ${persona.name} for the team "${pm.teamName}". Focus on ${persona.focus}.${summaryExtra} ` +
    `Below are your per-file insights for ${pm.insights.length} file(s) — synthesize across all of them rather than ` +
    `repeating any one file's details.\n\n${sections}`;

  const quick = await aiRouter.chat(
    null,
    [],
    "Give a quick overall insight across all these files: 2-4 bullet points, terse, only the most important " +
      "team-wide takeaways for this role.",
    profile,
    apiKey,
    system
  );
  const detailed = await aiRouter.chat(
    null,
    [],
    "Give a detailed overall insight across all these files: a thorough synthesis for this role, organized " +
      "with headings/bullets, noting patterns or contradictions across files where relevant.",
    profile,
    apiKey,
    system
  );

  return { quick: quick.content, detailed: detailed.content, generatedAt: new Date().toISOString() };
}
