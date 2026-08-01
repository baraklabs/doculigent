import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import "./ChatMessageContent.css";

// e.g. "3:45 PM" in the viewer's own locale/clock format — a wall-clock time, not a
// duration, so it doesn't reuse the citations' mm:ss `fmt` helper.
function formatMessageTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Renders one chat message's text as Markdown (bold/italic/lists/code/tables/links via
 * remark-gfm) instead of a raw string — LLM replies routinely come back with markdown
 * formatting (see openAiCompatibleClient.ts's plain-text completions), which was
 * previously showing up as literal asterisks/backticks. The colored/padded bubble
 * (.msg-bubble) wraps only this text; the timestamp + copy-to-clipboard footer below it is
 * a sibling outside that box, not another line inside it, and aligns to the same side as
 * the bubble (right for a question, left for an answer — see .msg.user/.msg.assistant in
 * AiWorkspace.css).
 *
 * Shared by AiAssistantPage.tsx and AiWorkspace.tsx's chat panes rather than duplicated,
 * since both render the same ChatMessage shape into the same .msg bubble.
 */
export function ChatMessageContent({ content, timestamp }: { content: string; timestamp?: string }) {
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
      <div className="msg-bubble msg-content markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
      <div className="msg-footer">
        {timestamp && <span className="msg-timestamp">{formatMessageTime(timestamp)}</span>}
        <button type="button" className="msg-copy-btn" title={copied ? "Copied!" : "Copy"} onClick={copy}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
    </div>
  );
}
