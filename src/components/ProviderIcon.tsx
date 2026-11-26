import { Plug } from "lucide-react";
import type { LlmProviderKind } from "@shared/types/models";
import openai from "../assets/providers/openai.svg?raw";
import claude from "../assets/providers/claude-color.svg";
import grok from "../assets/providers/grok.svg?raw";
import gemini from "../assets/providers/gemini-color.svg";
import groq from "../assets/providers/groq.svg?raw";
import deepseek from "../assets/providers/deepseek-color.svg";
import mistral from "../assets/providers/mistral-color.svg";
import together from "../assets/providers/together-color.svg";
import openrouter from "../assets/providers/openrouter-color.svg";
import ollama from "../assets/providers/ollama.svg?raw";
import lmstudio from "../assets/providers/lmstudio.svg?raw";

/** `mono` logos are single-colour (currentColor) SVGs inlined and tinted to the text colour so
 *  they stay readable in dark mode; the rest are full-colour brand marks shown as <img>. */
const ICONS: Partial<Record<LlmProviderKind, { src: string; mono: boolean; color?: string }>> = {
  openAi: { src: openai, mono: true },
  anthropic: { src: claude, mono: false },
  xai: { src: grok, mono: true },
  gemini: { src: gemini, mono: false },
  groq: { src: groq, mono: true, color: "#f55036" },
  deepSeek: { src: deepseek, mono: false },
  mistral: { src: mistral, mono: false },
  together: { src: together, mono: false },
  openRouter: { src: openrouter, mono: false },
  ollama: { src: ollama, mono: true },
  lmStudio: { src: lmstudio, mono: true },
};

export function ProviderIcon({ kind, size = 18 }: { kind: LlmProviderKind; size?: number }) {
  const icon = ICONS[kind];
  if (!icon) {
    return (
      <span className="provider-icon" style={{ width: size, height: size }} aria-hidden="true">
        <Plug size={size - 4} />
      </span>
    );
  }
  if (icon.mono) {
    // Inlined (not a CSS mask over an external file): masks need a same-origin fetch, which the
    // packaged app's file:// pages don't allow, and inline SVG just follows `color`.
    return (
      <span
        className="provider-icon provider-icon-mono"
        style={{ width: size, height: size, fontSize: size, color: icon.color ?? "var(--text)" }}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: icon.src.replace(/<title>.*?<\/title>/, "") }}
      />
    );
  }
  return <img className="provider-icon" src={icon.src} width={size} height={size} alt="" />;
}
