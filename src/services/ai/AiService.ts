import type { ChatMessage, LlmModelProfile, Summary, Transcript } from "@shared/types/models";

/** Routes to whichever LLM provider is configured in Settings — see
 *  electron/main/ai/index.ts for the actual provider implementations (Ollama/LM Studio/
 *  OpenAI/OpenRouter/custom are real via a shared OpenAI-compatible client; Anthropic is
 *  a stub, see FUNCTIONALITY.md §10). Pass `profileId` to use a specific saved model
 *  instead of the globally active one (the AI Assistant tab's model picker does this). */
export const AiService = {
  summarize(transcript: Transcript, profileId?: string): Promise<Summary> {
    return window.api.ai.summarize(transcript, profileId);
  },
  chat(transcript: Transcript, history: ChatMessage[], question: string, profileId?: string): Promise<ChatMessage> {
    return window.api.ai.chat(transcript, history, question, profileId);
  },
  testConnection(profile: LlmModelProfile, apiKey?: string | null): Promise<{ ok: boolean; message: string }> {
    return window.api.ai.testConnection(profile, apiKey);
  },
};
