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
  custom: { kind: "custom", baseUrl: "http://localhost:8080/v1", model: "", needsKey: true, capabilities: ["chat"] },
};

export function defaultLlmConfig(kind: LlmProviderKind): LlmProviderConfig {
  return DEFAULTS[kind];
}
