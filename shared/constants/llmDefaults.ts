import type { LlmProviderConfig, LlmProviderKind } from "../types/models";

/** Sensible defaults per provider kind — matches FUNCTIONALITY.md §10's table exactly.
 *  Every built-in kind defaults to chat-only capabilities (see LlmCapability's comment in
 *  shared/types/models.ts for why); "custom" also defaults to chat-only, but its
 *  capabilities are editable per-profile since the endpoint could be anything. */
const DEFAULTS: Record<LlmProviderKind, LlmProviderConfig> = {
  ollama: { kind: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3.1", needsKey: false, capabilities: ["chat"] },
  lmStudio: {
    kind: "lmStudio",
    baseUrl: "http://localhost:1234/v1",
    model: "local-model",
    needsKey: false,
    capabilities: ["chat"],
  },
  openAi: {
    kind: "openAi",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    needsKey: true,
    capabilities: ["chat"],
  },
  openRouter: {
    kind: "openRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    needsKey: true,
    capabilities: ["chat"],
  },
  anthropic: {
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-haiku-4-5",
    needsKey: true,
    capabilities: ["chat"],
  },
  // The providers below all expose an OpenAI-compatible /chat/completions + /models API,
  // so they need no client code of their own — just a base URL and a sensible default model.
  xai: { kind: "xai", baseUrl: "https://api.x.ai/v1", model: "grok-4", needsKey: true, capabilities: ["chat"] },
  gemini: {
    kind: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    needsKey: true,
    capabilities: ["chat"],
  },
  groq: {
    kind: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    needsKey: true,
    capabilities: ["chat"],
  },
  deepSeek: {
    kind: "deepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    needsKey: true,
    capabilities: ["chat"],
  },
  mistral: {
    kind: "mistral",
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-small-latest",
    needsKey: true,
    capabilities: ["chat"],
  },
  together: {
    kind: "together",
    baseUrl: "https://api.together.xyz/v1",
    model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    needsKey: true,
    capabilities: ["chat"],
  },
  custom: { kind: "custom", baseUrl: "http://localhost:8080/v1", model: "", needsKey: true, capabilities: ["chat"] },
};

/** One suggested model per capability for each provider, for the "Quick select" in Settings.
 *  `null` means the provider has no endpoint for that capability. `both` is a single model that
 *  serves both jobs; when present it is listed first. Transcription only counts
 *  when the provider serves OpenAI-style POST /audio/transcriptions (that's what the app's BYOK
 *  transcription client calls — see electron/main/transcription/byokClient.ts), so e.g. Gemini's
 *  OpenAI-compatible layer and Anthropic are `null` there. "custom" is intentionally absent:
 *  the endpoint could be anything, so we don't claim to know. */
export const PROVIDER_SUGGESTIONS: Partial<Record<LlmProviderKind, { chat: string | null; transcribe: string | null; both?: string }>> = {
  openAi: { chat: "gpt-4o-mini", transcribe: "whisper-1" },
  openRouter: { chat: "openai/gpt-4o-mini", transcribe: null },
  anthropic: { chat: "claude-haiku-4-5", transcribe: null },
  xai: { chat: "grok-4", transcribe: null },
  gemini: { chat: "gemini-2.5-flash", transcribe: null },
  groq: { chat: "llama-3.3-70b-versatile", transcribe: "whisper-large-v3-turbo" },
  deepSeek: { chat: "deepseek-chat", transcribe: null },
  mistral: { chat: "mistral-small-latest", transcribe: "voxtral-mini-latest", both: "voxtral-mini-latest" },
  together: { chat: "meta-llama/Llama-3.3-70B-Instruct-Turbo", transcribe: "openai/whisper-large-v3" },
  ollama: { chat: "llama3.1", transcribe: null },
  lmStudio: { chat: "local-model", transcribe: null },
};

export function defaultLlmConfig(kind: LlmProviderKind): LlmProviderConfig {
  // Fall back to "custom" for a kind this build doesn't know (e.g. a profile saved by a newer
  // version) so callers always get a complete config rather than undefined.
  return DEFAULTS[kind] ?? DEFAULTS.custom;
}
