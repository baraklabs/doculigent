/**
 * Wire types shared between the main and renderer processes. These mirror the data
 * model documented in FUNCTIONALITY.md §3 (camelCase throughout, same field names as
 * the original Tauri app's DTOs) so nothing about the UI's expectations has to change.
 */

export interface CaptureTarget {
  id: string; // "display:{index}" | "window:{platformId}"
  title: string;
  kind: "display" | "window";
}

/** Presets for the cursor-highlight feature — these swap the real OS-wide mouse cursor
 *  for the recording's duration (see electron/main/native/systemCursor.ts) rather than
 *  drawing an overlay: Electron's screen capture always bakes the real system cursor into
 *  the captured frames, so a drawn replacement would just show up alongside it. Windows
 *  only — a no-op on other platforms. */
export type CursorHighlightStyle = "default" | "hand" | "crosshair" | "bigger" | "huge" | "colorArrow" | "colorHand";

export interface OverlayConfig {
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  sizePct: number; // camera bubble size, as % of the recording's output width
  circular: boolean;
  showCamera: boolean;
  /** Which camera to use, by MediaDeviceInfo.deviceId — null means "let the browser
   *  pick the default", e.g. when only one camera is present. */
  cameraDeviceId: string | null;
  cursorHighlight: CursorHighlightStyle;
}

export interface MicConfig {
  /** Which microphone to use, by MediaDeviceInfo.deviceId — null means the default. */
  deviceId: string | null;
  /** When true, no mic audio is captured into the recording at all. */
  muted: boolean;
}

/**
 * A persisted recording. Supersedes the old Tauri app's in-memory-only
 * `RecordingSession` — this is a real row in the `videos` table (see db/schema.sql),
 * which is what backs the new Library feature.
 */
export interface Video {
  id: string;
  title: string;
  filePath: string;
  durationSecs: number;
  overlay: OverlayConfig;
  createdAt: string; // ISO 8601
  transcript: Transcript | null;
  summary: Summary | null;
  /** Which tab captured it — Record tab vs Meeting tab. Existing rows default to
   *  "record" (see db.ts's schema migration). */
  source: "record" | "meeting";
}

export interface TranscriptSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

export interface Transcript {
  language: string;
  /** "whisper-local": real on-device transcription via @huggingface/transformers (see
   *  electron/main/transcription/whisper.ts). The others remain unimplemented options. */
  engine: "whisper-local" | "whisper.cpp" | "assemblyai" | "deepgram";
  segments: TranscriptSegment[];
}

export interface Summary {
  tldr: string;
  keyPoints: string[];
  actionItems: string[];
}

export interface ChatCitation {
  timestamp: number;
  quote: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  citations?: ChatCitation[];
}

export type LlmProviderKind = "ollama" | "lmStudio" | "openAi" | "openRouter" | "anthropic" | "custom";

export const LOCAL_LLM_PROVIDERS: LlmProviderKind[] = ["ollama", "lmStudio"];

/** What a profile can actually be used for. Every built-in kind (ollama, lmStudio,
 *  openAi, openRouter, anthropic) is hardcoded to ["chat"] in shared/constants/
 *  llmDefaults.ts — none of them are wired into transcription today, so that's not
 *  user-editable for those. "custom" is the one kind whose endpoint could be anything, so
 *  its capabilities are editable per-profile in the Settings > Model Config form (see
 *  SettingsPage.tsx's ModelForm) rather than assumed. There's no cloud-transcription
 *  execution path yet (transcription is 100% local Whisper — see electron/main/
 *  transcription/whisper.ts) — marking a profile "transcribe"-capable just records the
 *  claim for now; SettingsPage.tsx uses it today only to stop a transcribe-only profile
 *  from being set as the single active chat/summarize profile. */
export type LlmCapability = "chat" | "transcribe";

export interface LlmProviderConfig {
  kind: LlmProviderKind;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  capabilities: LlmCapability[];
}

/**
 * A saved, named model configuration — the Settings "Model Config" list can hold many of
 * these (e.g. two different OpenRouter models with different keys), unlike the single
 * active `LlmProviderConfig` a chat/summarize call actually runs with. A profile IS a
 * provider config (same fields) plus the id/name needed to manage it as a list entry.
 */
export interface LlmModelProfile extends LlmProviderConfig {
  id: string;
  name: string;
}
