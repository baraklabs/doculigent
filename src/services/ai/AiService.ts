import type { ChatMessage, LlmModelProfile, Summary, Transcript } from "@shared/types/models";

export const AiService = {
  summarize(transcript: Transcript, profileId?: string): Promise<Summary> {
    return window.api.ai.summarize(transcript, profileId);
  },
  chat(
    transcript: Transcript | null,
    history: ChatMessage[],
    question: string,
    profileId?: string,
    systemPromptOverride?: string
  ): Promise<ChatMessage> {
    return window.api.ai.chat(transcript, history, question, profileId, systemPromptOverride);
  },
  testConnection(profile: LlmModelProfile, apiKey?: string | null): Promise<{ ok: boolean; message: string }> {
    return window.api.ai.testConnection(profile, apiKey);
  },
};
