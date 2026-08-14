
export interface CaptureTarget {
  id: string; 
  title: string;
  kind: "display" | "window";
}

export type CursorHighlightStyle =
  | "hidden"
  | "default"
  | "hand"
  | "crosshair"
  | "bigger"
  | "huge"
  | "colorArrow"
  | "colorHand";

export interface CursorTrackPoint {
  t: number;
  x: number;
  y: number;
}

export interface CursorMetadata {
  appVersion: string;
  recordingId: string;
  createdAt: string; // ISO 8601
  cursorStyle: CursorHighlightStyle;
  capture: {
    targetId: string;
    kind: "display" | "window";
    bounds: { x: number; y: number; width: number; height: number } | null;
    scaleFactor: number;
  };
  sampleRateHz: number;
  points: CursorTrackPoint[];
}

export type CameraBlurLevel = "none" | "soft" | "aggressive";

export interface OverlayConfig {
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  sizePct: number;
  circular: boolean;
  showCamera: boolean;
  cameraDeviceId: string | null;
  cursorHighlight: CursorHighlightStyle;
  mirrorCamera: boolean;
  cameraBlur: CameraBlurLevel;
}

export type CameraBubbleShape = "round" | "square" | "rectangle" | "rectangle-vertical";

export interface CameraBubbleConfig {
  shape: CameraBubbleShape;
  roundedCorners: boolean;
  freeformResize: boolean;
  mirror: boolean;
  cameraDeviceId: string | null;
  blur: CameraBlurLevel;
}

export interface CameraBubbleBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RecordingDockOrientation = "horizontal" | "vertical";

export interface RecordingDockConfig {
  orientation: RecordingDockOrientation;
}

export interface RecordingDockBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RecordingDockAction = "pause" | "resume" | "restart" | "stop" | "discard";

export interface RecordingDockTimerSync {
  elapsedMs: number;
  paused: boolean;
}

export interface MicConfig {
  deviceId: string | null;
  muted: boolean;
}

export interface SystemAudioConfig {
  enabled: boolean;
  sourceId: string | null;
}

export type CaptureMode = "display" | "window" | "area" | "camera";

export interface AreaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AreaSelectResult {
  targetId: string;
  rect: AreaRect;
}

export interface AutoTranscribeSettings {
  all: boolean;
  recording: boolean;
  videoImport: boolean;
  audioImport: boolean;
  teamsContent: boolean;
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
  syncedFromTeamFileId?: string;
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
  timestamp?: string;
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

export type AppIntegrationKind = "github" | "slack";

export interface AppIntegration {
  id: string;
  kind: AppIntegrationKind;
  name: string;
}
