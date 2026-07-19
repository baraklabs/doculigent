/**
 * Languages offered in the Meeting tab's language picker. Codes match what Whisper
 * expects for its `language` decoding option (see electron/main/transcription/whisper.ts).
 * "auto" omits the option entirely and lets Whisper detect the spoken language itself.
 */
export interface TranscriptionLanguageOption {
  code: string;
  label: string;
}

export const TRANSCRIPTION_LANGUAGES: TranscriptionLanguageOption[] = [
  { code: "auto", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "ru", label: "Russian" },
  { code: "zh", label: "Chinese" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "hi", label: "Hindi" },
  { code: "bn", label: "Bengali" },
  { code: "ar", label: "Arabic" },
];

export const DEFAULT_TRANSCRIPTION_LANGUAGE = "en";
