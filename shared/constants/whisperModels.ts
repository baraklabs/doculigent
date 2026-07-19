/**
 * Local on-device Whisper model sizes offered in Settings — see
 * electron/main/transcription/whisper.ts for how the selected size maps to an
 * @huggingface/transformers model id and gets (re)loaded. Bigger sizes trade a larger
 * one-time download and slower per-chunk inference for better accuracy, which matters
 * most for non-English languages (see whisper.ts's comment on why "tiny" was dropped in
 * favor of "base" as the default).
 */
export type WhisperModelSize = "tiny" | "base" | "small" | "medium" | "large-v3" | "turbo";

export interface WhisperModelOption {
  size: WhisperModelSize;
  /** Short label for the quick-select buttons, e.g. "Tiny". */
  label: string;
  /** One-line size/accuracy/speed tradeoff, shown under the picker for whichever size
   *  is currently selected. */
  description: string;
  hfModelId: string;
  /** Whether OpenAI released a dedicated English-only checkpoint for this size (e.g.
   *  "Xenova/whisper-tiny.en") — true for tiny/base/small/medium, false for large-v3 and
   *  turbo (OpenAI never trained English-only variants of those). Gates whether
   *  whisperModelHfIdEn is safe to call for a given size — see its own comment. */
  hasEnglishVariant: boolean;
  /** Approximate one-time download size — the quantized ONNX weights actually used here
   *  (encoder + merged decoder, int8 dynamic quantization), not the model's full fp32
   *  size. tiny/base measured from a real download; small/medium/large-v3/turbo are
   *  measured from the actual quantized file sizes on the Hugging Face Hub. */
  approxDownloadMb: number;
  /** What machine this size is realistically comfortable on, specifically for the live
   *  Meeting-tab captions (the non-live Library/AI Assistant transcribe path has no
   *  real-time deadline, so any size works there — see whisper.ts). Now that GPU
   *  offload is used automatically when available (see whisper.ts), these CPU-only
   *  descriptions are the worst case — a supported GPU (DirectML on Windows, CUDA on
   *  Linux, CoreML on macOS) comfortably beats them. */
  recommendedFor: string;
}

export const WHISPER_MODELS: WhisperModelOption[] = [
  {
    size: "tiny",
    label: "Tiny",
    description: "Fastest, weakest non-English accuracy.",
    hfModelId: "Xenova/whisper-tiny",
    hasEnglishVariant: true,
    approxDownloadMb: 41,
    recommendedFor: "Any modern CPU, including low-power/older laptops.",
  },
  {
    size: "base",
    label: "Base",
    description: "Balanced — recommended default.",
    hfModelId: "Xenova/whisper-base",
    hasEnglishVariant: true,
    approxDownloadMb: 77,
    recommendedFor: "Comfortable real-time captions on most 4+ core laptop CPUs from the last ~6 years.",
  },
  {
    size: "small",
    label: "Small",
    description: "More accurate than base, slower to download and transcribe.",
    hfModelId: "Xenova/whisper-small",
    hasEnglishVariant: true,
    approxDownloadMb: 249,
    recommendedFor: "6+ core CPU recommended to keep up with live captions in real time; any CPU is fine for non-live transcription.",
  },
  {
    size: "medium",
    label: "Medium",
    description: "High accuracy, especially for non-English languages.",
    hfModelId: "Xenova/whisper-medium",
    hasEnglishVariant: true,
    approxDownloadMb: 776,
    recommendedFor: "A supported GPU (DirectML/CUDA/CoreML) for real-time captions; CPU-only is fine for non-live transcription but will lag behind live speech.",
  },
  {
    size: "large-v3",
    label: "Large v3",
    description: "Most accurate model available — no English-only variant (OpenAI never released one).",
    hfModelId: "Xenova/whisper-large-v3",
    hasEnglishVariant: false,
    approxDownloadMb: 1560,
    recommendedFor: "A supported GPU is effectively required for real-time captions; CPU-only is only realistic for non-live transcription.",
  },
  {
    size: "turbo",
    label: "Turbo",
    description: "Distilled from Large v3 — nearly the same accuracy at roughly Base-level speed. No English-only variant.",
    hfModelId: "onnx-community/whisper-large-v3-turbo",
    hasEnglishVariant: false,
    approxDownloadMb: 1085,
    recommendedFor: "A supported GPU for the best experience; a modern multi-core CPU can still keep up with live captions.",
  },
];

export const DEFAULT_WHISPER_MODEL: WhisperModelSize = "base";

export function whisperModelHfId(size: WhisperModelSize): string {
  const match = WHISPER_MODELS.find((m) => m.size === size) ?? WHISPER_MODELS.find((m) => m.size === DEFAULT_WHISPER_MODEL);
  return match!.hfModelId;
}

export function whisperModelHasEnglishVariant(size: WhisperModelSize): boolean {
  const match = WHISPER_MODELS.find((m) => m.size === size);
  return match?.hasEnglishVariant ?? true;
}

/** The English-only variant of a size (e.g. "Xenova/whisper-tiny.en") — OpenAI's own
 *  Whisper paper documents these as equal-or-better than the multilingual model of the
 *  same size specifically for English, since they're single-language/single-task rather
 *  than splitting capacity across ~100 languages. whisper.ts uses this whenever the
 *  Meeting tab's language picker is explicitly set to English (not "auto", which could be
 *  any language and needs the multilingual model) AND whisperModelHasEnglishVariant(size)
 *  is true — large-v3 and turbo have no such checkpoint, so callers must check that first
 *  (calling this for one of those sizes would return a repo id that doesn't exist). */
export function whisperModelHfIdEn(size: WhisperModelSize): string {
  return `${whisperModelHfId(size)}.en`;
}

/** Whether a model's files are on disk, and how big they are — see
 *  electron/main/transcription/modelCache.ts for how this gets computed and
 *  Settings > Transcription for where it's shown/managed. */
export interface WhisperModelStatus {
  size: WhisperModelSize;
  downloaded: boolean;
  sizeBytes: number;
}
