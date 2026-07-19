import type { ChatMessage, LlmProviderConfig, Summary, Transcript } from "@shared/types/models";
import { NotImplementedError } from "@shared/ipc/errors";
import {
  chatWithOpenAiCompatible,
  summarizeWithOpenAiCompatible,
  testOpenAiCompatibleConnection,
} from "./openAiCompatibleClient";

export async function summarize(
  transcript: Transcript,
  config: LlmProviderConfig,
  apiKey: string | null
): Promise<Summary> {
  if (config.kind === "anthropic") {
    // Anthropic's native Messages API has a different request/response shape than the
    // OpenAI-compatible path every other provider uses — see the `claude-api` skill for
    // the current contract (model ids, params) when implementing this for real.
    throw new NotImplementedError("anthropic summarize");
  }
  return summarizeWithOpenAiCompatible(transcript, config, apiKey);
}

export async function chat(
  transcript: Transcript,
  history: ChatMessage[],
  question: string,
  config: LlmProviderConfig,
  apiKey: string | null
): Promise<ChatMessage> {
  if (config.kind === "anthropic") {
    throw new NotImplementedError("anthropic chat");
  }
  return chatWithOpenAiCompatible(transcript, history, question, config, apiKey);
}

export async function testConnection(config: LlmProviderConfig, apiKey: string | null): Promise<void> {
  if (config.kind === "anthropic") {
    throw new NotImplementedError("anthropic connection test");
  }
  return testOpenAiCompatibleConnection(config, apiKey);
}
