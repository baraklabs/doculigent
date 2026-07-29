/**
 * Calls a user-configured BYOK (bring-your-own-key) endpoint for transcription — a
 * "custom" LLM profile tagged with the "transcribe" capability (see SettingsPage.tsx's
 * BYOK cards). Speaks the same OpenAI-compatible convention as
 * electron/main/ai/openAiCompatibleClient.ts's chat/completions client: POST to
 * `${baseUrl}/audio/transcriptions`, multipart file + model, Bearer auth — this is what
 * OpenAI's own Whisper API, Groq, and most self-hosted whisper.cpp/faster-whisper servers
 * all speak, so one implementation covers all of them without per-provider branching.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { LlmModelProfile, Transcript, TranscriptSegment } from "@shared/types/models";

interface ByokTranscriptionResponse {
  text?: string;
  segments?: { start?: number; end?: number; text?: string }[];
}

function toSegments(data: ByokTranscriptionResponse, fallbackDurationSecs: number): TranscriptSegment[] {
  if (data.segments?.length) {
    return data.segments
      .map((s) => ({ start: s.start ?? 0, end: s.end ?? s.start ?? 0, speaker: "Speaker", text: (s.text ?? "").trim() }))
      .filter((s) => s.text.length > 0);
  }
  const text = (data.text ?? "").trim();
  return text ? [{ start: 0, end: fallbackDurationSecs, speaker: "Speaker", text }] : [];
}

/** Minimal PCM16 mono WAV encoder — mirrors transcriptionWorker.ts's readPcm16Wav in
 *  reverse: a plain 44-byte header plus little-endian 16-bit samples is all any
 *  transcription API needs, so there's no reason to pull in a dependency for it. */
function encodeWav16kMono(samples: Float32Array): Buffer {
  const sampleRate = 16000;
  const numSamples = samples.length;
  const buffer = Buffer.alloc(44 + numSamples * 2);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate (sampleRate * blockAlign)
  buffer.writeUInt16LE(2, 32); // block align (channels * bytesPerSample)
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(numSamples * 2, 40);
  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), 44 + i * 2);
  }
  return buffer;
}

async function postAudio(
  audioBytes: Buffer,
  filename: string,
  mimeType: string,
  profile: LlmModelProfile,
  apiKey: string | null,
  language: string | undefined,
  fallbackDurationSecs: number
): Promise<Transcript> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audioBytes)], { type: mimeType }), filename);
  form.append("model", profile.model);
  if (language && language !== "auto") form.append("language", language);

  const url = `${profile.baseUrl.replace(/\/$/, "")}/audio/transcriptions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      body: form,
    });
  } catch {
    // fetch() throws a bare "TypeError: fetch failed" for DNS/connection failures — not
    // useful surfaced as-is (it also gets wrapped in Electron's own "Error invoking remote
    // method '...'" boilerplate once it crosses the IPC boundary), so name the actual
    // problem instead: this profile's Base URL isn't reachable right now.
    throw new Error(
      `Couldn't reach "${profile.name || "BYOK"}" at ${profile.baseUrl} — check its Base URL in Settings and that the server is running.`
    );
  }
  if (!res.ok) {
    throw new Error(`"${profile.name || "BYOK"}" transcription failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as ByokTranscriptionResponse;
  return {
    language: language ?? "auto",
    engine: "whisper-local",
    segments: toSegments(data, fallbackDurationSecs),
  };
}

/** Full-recording transcription (Library's Transcribe/Re-transcribe) — uploads the file
 *  as-is; every provider this targets accepts webm/mp4/mp3/wav/m4a directly, so there's no
 *  need to decode/re-encode it first the way the local Whisper path does. */
export async function transcribeFileWithByok(
  filePath: string,
  profile: LlmModelProfile,
  apiKey: string | null,
  language: string | undefined
): Promise<Transcript> {
  const bytes = await fs.readFile(filePath);
  // Duration is unknown without decoding the container — only used as a fallback single-
  // segment's `end` when the endpoint doesn't return its own segment timestamps, so 0 here
  // just means that fallback segment reports a 0-length window rather than a wrong one.
  return postAudio(bytes, path.basename(filePath), "application/octet-stream", profile, apiKey, language, 0);
}

/** Live-segment transcription (Meeting tab) — the renderer hands over already-decoded
 *  16kHz mono PCM (see AudioRecordingService's decodeToPcm16k), which gets wrapped in a
 *  plain WAV container here since raw PCM alone isn't a file format any HTTP API accepts. */
export async function transcribePcmWithByok(
  samples: Float32Array,
  profile: LlmModelProfile,
  apiKey: string | null,
  language: string | undefined
): Promise<Transcript> {
  const wav = encodeWav16kMono(samples);
  const durationSecs = samples.length / 16000;
  return postAudio(wav, "audio.wav", "audio/wav", profile, apiKey, language, durationSecs);
}
