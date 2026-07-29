import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import "./ChatMessageContent.css";

/**
 * Renders one chat message's text as Markdown (bold/italic/lists/code/tables/links via
 * remark-gfm) instead of a raw string — LLM replies routinely come back with markdown
 * formatting (see openAiCompatibleClient.ts's plain-text completions), which was
 * previously showing up as literal asterisks/backticks. Also exposes a copy-to-clipboard
 * button, shown on hover, for grabbing the reply as plain text.
 *
 * Shared by AiAssistantPage.tsx and AiWorkspace.tsx's chat panes rather than duplicated,
 * since both render the same ChatMessage shape into the same .msg bubble.
 */
export function ChatMessageContent({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission denied or unavailable — nothing more to do here; the button
      // simply won't flip to "Copied!".
    }
  }

  return (
    <div className="msg-content-wrap">
      <div className="msg-content markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
      <button type="button" className="msg-copy-btn" title={copied ? "Copied!" : "Copy"} onClick={copy}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}
