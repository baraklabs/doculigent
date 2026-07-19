import type { LlmProviderKind } from "@shared/types/models";
import { LOCAL_LLM_PROVIDERS } from "@shared/types/models";

export { LOCAL_LLM_PROVIDERS };

/**
 * Provider directory for the Settings UI (kind -> display label). Unlike a typical
 * multi-provider abstraction, there's no per-kind branching needed *here* — actually
 * calling a provider (network request, API key lookup) already happens once, main-side,
 * in electron/main/ai/index.ts, which is where a real client per provider lives (keytar
 * and network calls are main-process concerns). AiService just calls that single
 * provider-agnostic gateway; this list exists purely so Settings can render a dropdown.
 */
export const AI_PROVIDERS: { kind: LlmProviderKind; label: string }[] = [
  { kind: "ollama", label: "Ollama (local)" },
  { kind: "lmStudio", label: "LM Studio (local)" },
  { kind: "openAi", label: "OpenAI" },
  { kind: "openRouter", label: "OpenRouter" },
  { kind: "anthropic", label: "Anthropic (Claude)" },
  { kind: "custom", label: "Custom (OpenAI-compatible)" },
];
