
export interface CaptureTarget {
  id: string; // "display:{index}" | "window:{platformId}"
  title: string;
  kind: "display" | "window";
}

/** "hidden" keeps the real pointer completely untouched on screen but excludes it from the
 *  recorded video — see native/screenCapture.ts for how (gdigrab's draw_mouse, Windows +
 *  whole-display captures only; elsewhere this falls back to the ordinary pipeline, where
 *  the pointer ends up baked in same as any other style). Either way it leaves the frames
 *  free for the Edit section to draw its own cursor from the sidecar track. "default"
 *  leaves the real pointer's appearance alone too, but doesn't try to exclude it. */
export type CursorHighlightStyle =
  | "hidden"
  | "default"
  | "hand"
  | "crosshair"
  | "bigger"
  | "huge"
  | "colorArrow"
  | "colorHand";

/** One sampled pointer position. `t` is milliseconds since capture started; `x`/`y` are
 *  screen coordinates in DIPs, the same space as Electron's Display.bounds. */
export interface CursorTrackPoint {
  t: number;
  x: number;
  y: number;
}

/**
 * Sidecar written to `<recording folder>/metadata/cursor.json`. Records where the pointer
 * was for every frame of the capture so the Edit section can re-draw it in any style —
 * smoothed, enlarged, click-animated — instead of being stuck with whatever was baked into
 * the pixels. `appVersion` is stamped so a later build can migrate an older track.
 */
export interface CursorMetadata {
  appVersion: string;
  recordingId: string;
  createdAt: string; // ISO 8601
  /** Which style the real pointer was wearing while recording. "hidden" means the frames
   *  contain no pointer at all and Edit can render one freely; any other value is baked
   *  into the pixels, so a drawn cursor sits on top of it. */
  cursorStyle: CursorHighlightStyle;
  capture: {
    targetId: string;
    kind: "display" | "window";
    /** The captured display in DIPs — the frame of reference for every point. Null for a
     *  window capture, where points can't be mapped to the frame reliably. */
    bounds: { x: number; y: number; width: number; height: number } | null;
    scaleFactor: number;
  };
  /** Nominal sampling rate; actual spacing is in each point's `t`. */
  sampleRateHz: number;
  /** Sampled only when the pointer actually moved, so gaps mean "held still". */
  points: CursorTrackPoint[];
}

export interface OverlayConfig {
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  sizePct: number; 
  circular: boolean;
  showCamera: boolean;
  cameraDeviceId: string | null;
  cursorHighlight: CursorHighlightStyle;
}

export interface MicConfig {
  deviceId: string | null;
  muted: boolean;
}

export interface Video {
  id: string;
  title: string;
  filePath: string;
  durationSecs: number;
  overlay: OverlayConfig;
  createdAt: string; // ISO 8601
  transcript: Transcript | null;
  summary: Summary | null;
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
  engine: "whisper-local" | "whisper.cpp" | "assemblyai" | "deepgram" | "transcript-import";
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

export type LlmCapability = "chat" | "transcribe";

export interface LlmProviderConfig {
  kind: LlmProviderKind;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  capabilities: LlmCapability[];
}

export interface LlmModelProfile extends LlmProviderConfig {
  id: string;
  name: string;
}

export type AppIntegrationKind = "github" | "slack" | "teams";

/** A connected external app — GitHub, Slack, or Microsoft Teams. Unlike LlmModelProfile
 *  there's no per-kind config beyond the kind itself (no baseUrl/model): each kind's single
 *  credential (PAT / bot token / webhook URL) is stored separately in the OS keychain, same
 *  as an LLM profile's API key — see electron/main/native/keyring.ts. Multiple integrations
 *  of the same kind are supported (e.g. two GitHub orgs), distinguished by `name`. */
export interface AppIntegration {
  id: string;
  kind: AppIntegrationKind;
  name: string;
}
