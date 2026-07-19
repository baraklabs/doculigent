import { ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type { ChatMessage, LlmModelProfile, Summary, Transcript } from "@shared/types/models";
import { getActiveLlmProfile, getLlmProfile } from "../native/settingsStore";
import { getLlmApiKey } from "../native/keyring";
import * as aiRouter from "../ai";

function resolveProfile(profileId: string | undefined): LlmModelProfile {
  const profile = profileId ? getLlmProfile(profileId) : getActiveLlmProfile();
  if (!profile) throw new Error("No AI model is configured — add one in Settings.");
  return profile;
}

export function registerAiIpc(): void {
  ipcMain.handle(
    Channels.ai.summarize,
    async (_event, transcript: Transcript, profileId?: string): Promise<Summary> => {
      const profile = resolveProfile(profileId);
      const apiKey = profile.needsKey ? await getLlmApiKey(profile.id) : null;
      return aiRouter.summarize(transcript, profile, apiKey);
    }
  );

  ipcMain.handle(
    Channels.ai.chat,
    async (
      _event,
      transcript: Transcript,
      history: ChatMessage[],
      question: string,
      profileId?: string
    ): Promise<ChatMessage> => {
      const profile = resolveProfile(profileId);
      const apiKey = profile.needsKey ? await getLlmApiKey(profile.id) : null;
      return aiRouter.chat(transcript, history, question, profile, apiKey);
    }
  );

  ipcMain.handle(
    Channels.ai.testConnection,
    async (_event, profile: LlmModelProfile, apiKeyOverride?: string | null): Promise<{ ok: boolean; message: string }> => {
      try {
        const apiKey = apiKeyOverride || (profile.needsKey ? await getLlmApiKey(profile.id) : null);
        await aiRouter.testConnection(profile, apiKey);
        return { ok: true, message: "Connected successfully." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}
