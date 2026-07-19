/**
 * A single client for every OpenAI-compatible provider (Ollama, LM Studio, OpenAI,
 * OpenRouter, and any custom OpenAI-compatible endpoint) — per FUNCTIONALITY.md §10,
 * these all speak the same `/chat/completions` schema, so one implementation
 * parameterized by baseUrl/model/apiKey covers all five; only Anthropic's native
 * Messages API needs a different shape (see electron/main/ai/index.ts).
 */
import type { ChatMessage, LlmProviderConfig, Summary, Transcript } from "@shared/types/models";

interface OpenAiChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

async function chatCompletion(
  config: LlmProviderConfig,
  apiKey: string | null,
  messages: { role: string; content: string }[]
): Promise<string> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model: config.model, messages }),
  });

  if (!res.ok) {
    throw new Error(`${config.kind} request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as OpenAiChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${config.kind} returned no completion content`);
  return content;
}

function transcriptToPrompt(transcript: Transcript): string {
  return transcript.segments.map((s) => `[${s.speaker}] ${s.text}`).join("\n");
}

/** Lightweight reachability/auth check: every OpenAI-compatible server (Ollama, LM
 *  Studio, OpenAI, OpenRouter, custom) exposes GET /models, so a 2xx there is enough to
 *  confirm the base URL and key are good without spending a completion. */
export async function testOpenAiCompatibleConnection(
  config: LlmProviderConfig,
  apiKey: string | null
): Promise<void> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) {
    throw new Error(`${config.kind} connection test failed: ${res.status} ${await res.text()}`);
  }
}

export async function summarizeWithOpenAiCompatible(
  transcript: Transcript,
  config: LlmProviderConfig,
  apiKey: string | null
): Promise<Summary> {
  const system =
    "You summarize meeting/screen-recording transcripts. Respond ONLY with JSON matching " +
    '{"tldr": string, "keyPoints": string[], "actionItems": string[]}, no other text.';
  const content = await chatCompletion(config, apiKey, [
    { role: "system", content: system },
    { role: "user", content: transcriptToPrompt(transcript) },
  ]);
  try {
    return JSON.parse(content) as Summary;
  } catch {
    // The model didn't follow the JSON instruction — surface its raw text as the tl;dr
    // rather than failing the whole request outright.
    return { tldr: content, keyPoints: [], actionItems: [] };
  }
}

export async function chatWithOpenAiCompatible(
  transcript: Transcript,
  history: ChatMessage[],
  question: string,
  config: LlmProviderConfig,
  apiKey: string | null
): Promise<ChatMessage> {
  const system =
    "Answer questions about the following transcript. Be concise and only use information " +
    `from it.\n\n${transcriptToPrompt(transcript)}`;
  const content = await chatCompletion(config, apiKey, [
    { role: "system", content: system },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: question },
  ]);
  return { role: "assistant", content };
}
